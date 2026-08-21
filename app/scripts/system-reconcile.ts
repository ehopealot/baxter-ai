// The system-task reconciliation body (system-scheduled-tasks plan, T4). Runs
// INSIDE an open schedule-store.mutate() transaction (heartbeat startup gate,
// every tick, and every schedule-cli system command): full reserved-namespace
// validation that fails closed BEFORE any mutation byte, a GENERAL cron-derived
// catch-up anchor (each definition anchors at its OWN cron through the same
// tz-aware recurrence engine resolveNextRun uses -- no hardcoded 08:00, no
// registry-wide daily-only shape gate), the shared in-lock guard for every
// id-based mutation call site (refuseOnCollision), then creation/repair/
// collapse of canonical system records. Pure: no store I/O, no env, no clock.
import parser from "cron-parser";
import { isReservedId, resolveNextRun, type Task } from "./schedule-store.ts";
import { canonicalSystemId, systemTaskEnabled, type SystemTaskDefinition } from "./system-tasks.ts";
import { tzDateToken } from "./tz.ts";

// Fail-closed refusal for reserved-namespace violations. Carries the colliding
// record ids and a message with the operator repair instruction; the runtime
// itself never renames, deletes, or bypasses a colliding record.
export class ReservedIdCollisionError extends Error {
  readonly ids: string[];
  constructor(ids: string[], message: string) {
    super(message);
    this.name = "ReservedIdCollisionError";
    this.ids = ids;
  }
}

// The duplicated-id ambiguity refusal refuseOnCollision's mutatedId guard
// throws: a PER-RECORD recoverable refusal (the mutation is skipped, nothing
// written) just like ReservedIdCollisionError, so a catch site that wants to
// continue past individual refusals narrows on exactly these two and rethrows
// everything else (lock/FS/JSON failures are infrastructure errors, not
// refusals -- they must reach the caller's error handler, not be mislabeled).
export class AmbiguousIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousIdError";
  }
}

// The catch-up anchor for creating (and repairing next_run_at of) a canonical
// system record: the definition's OWN cron in the household tz. The most recent
// occurrence at-or-before now (cron-parser's prev()) is the anchor when it
// falls on now's tz-local day -- today's already-passed occurrence is the
// same-day catch-up anchor and lands due now; otherwise the next occurrence
// strictly after now. For the digest cron '0 8 * * *' this is byte-identical
// to the spec's today's-08:00 rule; weekly or hourly definitions anchor by the
// same rule with no code change.
export function cronCatchUpAnchor(cron: string, now: Date, tz: string): string {
  const it = parser.parseExpression(cron, { currentDate: now, tz });
  const prev = it.prev().toDate();
  return tzDateToken(prev, tz) === tzDateToken(now, tz)
    ? prev.toISOString()
    : it.next().toDate().toISOString();
}

// Reserved-namespace validation, run BEFORE any mutation: the caller's
// transaction must write nothing when this throws, so every record is
// preserved byte-for-byte. (a) every record under a `system:` id must be the
// canonical record of a REGISTERED definition (exact canonical id AND system
// metadata carrying exactly that key) -- an ordinary record under any reserved
// id, an unknown system:* id, and a wrong-key record are each collisions;
// (b) every registered key's duplicate set (records with that canonical id OR
// carrying that system.key) must contain only matching canonical records -- an
// ordinary-id record carrying a registered key is a mixed ordinary/system
// duplicate set and a collision; (c) the presence or type of system.enabled is
// NEVER part of a collision -- malformed values are repaired by
// reconcileSystemTasks, not refused here.
export function validateReservedNamespace(
  tasks: Task[],
  registry: readonly SystemTaskDefinition<string>[],
): void {
  const collisions = new Map<string, string>();
  for (const t of tasks) {
    if (!isReservedId(t.id)) continue;
    const def = registry.find((d) => canonicalSystemId(d.key) === t.id);
    const valid = def != null && t.system != null && t.system.key === def.key;
    if (!valid) {
      collisions.set(
        t.id,
        def == null
          ? `no registered system task owns reserved id '${t.id}'`
          : `record under canonical id '${t.id}' is not its registered system record (system key ${t.system == null ? "absent" : `'${t.system.key}'`})`,
      );
    }
  }
  for (const d of registry) {
    const cid = canonicalSystemId(d.key);
    for (const m of tasks) {
      if (m.id !== cid && m.system?.key === d.key) {
        collisions.set(m.id, `record '${m.id}' carries system key '${d.key}' outside its canonical record ${cid}`);
      }
    }
  }
  if (collisions.size > 0) {
    const lines = [...collisions.entries()].map(([id, why]) => `  - ${id}: ${why}`).join("\n");
    throw new ReservedIdCollisionError(
      [...collisions.keys()],
      `reserved system-task id collision -- refusing to touch the schedule:\n${lines}\n` +
        "Operator repair required: change the colliding record's id to a non-reserved one (re-add it via schedule-cli add), " +
        "or cancel it when unambiguous (schedule-cli cancel <id>). The runtime never renames, deletes, or bypasses these " +
        "records; nothing was written.",
    );
  }
}

interface RefuseOnCollisionOptions {
  // Validate the store as-if this ONE record were already removed: cancel's
  // operator-repair path, since the single unambiguous ordinary record under a
  // reserved id is precisely the state full validation rejects. Callers must
  // refuse ambiguous ids before using it (exactly one record carries the id).
  excludeId?: string;
  // The id about to be mutated: refuse loudly when more than one record carries
  // it (the queue helpers applyClaim/applyOnSuccess/applyOnFailure mutate EVERY
  // record sharing an id, so ambiguity must refuse rather than multi-mutate).
  mutatedId?: string;
}

// The shared in-lock guard every id-based mutation call site runs FIRST inside
// its transaction (schedule-cli cancel; heartbeat claim/success/failure,
// give-up cron advance, and the deferredByCap deferral write): a throw aborts
// that mutation with no write.
export function refuseOnCollision(
  tasks: Task[],
  registry: readonly SystemTaskDefinition<string>[],
  opts: RefuseOnCollisionOptions = {},
): void {
  const input = opts.excludeId != null ? tasks.filter((t) => t.id !== opts.excludeId) : tasks;
  validateReservedNamespace(input, registry);
  if (opts.mutatedId != null) {
    const count = tasks.filter((t) => t.id === opts.mutatedId).length;
    if (count > 1) {
      throw new AmbiguousIdError(
        `refusing id-based mutation: '${opts.mutatedId}' is ambiguous (${count} records share the id; ` +
          "the queue helpers mutate every record sharing an id, so repair the duplicate set first)",
      );
    }
  }
}

export interface ReconcileOutcome {
  tasks: Task[];
  changed: boolean;
}

// Plain code-unit lexicographic compare (locale-free, deterministic).
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Deterministic survivor for a key's duplicate set: the exactly-one canonical-id
// member when present; otherwise the earliest created_at, ties broken by the
// lexicographically smallest id, then input order (fully deterministic even for
// identical ids and created_at).
function pickSurvivor(members: Task[], cid: string): Task {
  const canonicalOnes = members.filter((m) => m.id === cid);
  if (canonicalOnes.length === 1) return canonicalOnes[0];
  const order = new Map(members.map((m, i) => [m, i]));
  return [...members].sort(
    (a, b) =>
      cmp(String(a.created_at ?? ""), String(b.created_at ?? "")) ||
      cmp(a.id, b.id) ||
      (order.get(a)! - order.get(b)!),
  )[0];
}

// Registry-owned field restoration + queue repair on a key's canonical record.
// `at` -> null is load-bearing: resolveNextRun prioritizes a non-null at over
// cron, so a hand-edited past at would re-anchor every next occurrence to that
// instant after each completion and hot-fire the task every tick. Queue
// progress is preserved for an unchanged definition; a cron or tz change
// invalidates it (clear claim/retry, recompute strictly after now); an
// unparseable next_run_at is repaired via the definition's own cron anchor.
function normalizeCanonicalRecord(
  rec: Task,
  def: SystemTaskDefinition<string>,
  tz: string,
  now: Date,
  log: (m: string) => void,
): Task {
  const cronChanged = rec.cron !== def.cron;
  const tzChanged = rec.tz !== tz;
  let out = rec;
  if (out.desc !== def.desc) out = { ...out, desc: def.desc };
  if (out.cron !== def.cron) out = { ...out, cron: def.cron };
  if (out.at !== null) out = { ...out, at: null };
  if (out.tz !== tz) out = { ...out, tz };
  if (out.task != null) {
    const { task: _removed, ...rest } = out;
    out = rest;
  }
  if (out.deliver !== null) out = { ...out, deliver: null };
  if (typeof out.system?.enabled !== "boolean") {
    log(`system-reconcile: repaired non-boolean system.enabled on ${out.id} to literal false`);
    out = { ...out, system: { key: def.key, enabled: false } };
  }
  if (cronChanged || tzChanged) {
    out = {
      ...out,
      invisible_until: null,
      attempts: 0,
      next_run_at: resolveNextRun({ cron: def.cron, tz }, now.getTime(), tz),
    };
  } else if (typeof out.next_run_at !== "string" || Number.isNaN(Date.parse(out.next_run_at))) {
    out = { ...out, next_run_at: cronCatchUpAnchor(def.cron, now, tz) };
  }
  return out;
}

// Reconciliation gate body. FIRST every registry cron must parse through the
// recurrence engine (a malformed definition fails loud with its parse error
// before any mutation is staged), THEN the namespace validates fail-closed
// (a throw propagates and the caller's transaction writes nothing). After
// that: create missing canonical records, collapse duplicates onto a
// deterministic survivor (disabled-wins), restore registry-owned fields,
// repair malformed enabled values, and force-disable unknown keys on ordinary
// ids. Never checks HEARTBEAT_MAX_TASKS, never deletes unrelated records,
// never re-enables a disabled record, and returns the SAME objects when
// nothing changed so the store skips the rewrite.
export function reconcileSystemTasks(
  tasks: Task[],
  registry: readonly SystemTaskDefinition<string>[],
  now: Date,
  tz: string,
  log: (m: string) => void,
): ReconcileOutcome {
  for (const def of registry) parser.parseExpression(def.cron, { currentDate: now, tz });
  validateReservedNamespace(tasks, registry);

  const registeredKeys = new Set(registry.map((d) => d.key));
  let result = tasks.slice();
  let changed = false;

  for (const def of registry) {
    const cid = canonicalSystemId(def.key);
    const members = tasks.filter((t) => t.id === cid || t.system?.key === def.key);
    if (members.length === 0) {
      result.push({
        id: cid,
        desc: def.desc,
        cron: def.cron,
        at: null,
        tz,
        next_run_at: cronCatchUpAnchor(def.cron, now, tz),
        invisible_until: null,
        attempts: 0,
        deliver: null,
        system: { key: def.key, enabled: true },
        created_at: now.toISOString(),
      });
      changed = true;
      continue;
    }
    // Validation proved every member is a matching canonical system record, so
    // duplicates are safe to collapse: survivor's queue fields persist, enabled
    // is true only when every member's is the literal boolean true.
    let rec = pickSurvivor(members, cid);
    if (members.length > 1) {
      rec = { ...rec, system: { key: def.key, enabled: members.every(systemTaskEnabled) } };
      const memberSet = new Set(members);
      const at = result.findIndex((t) => memberSet.has(t));
      result = result.filter((t) => !memberSet.has(t));
      result.splice(at, 0, rec);
      changed = true;
      log(`system-reconcile: collapsed ${members.length} duplicate records for system task '${def.key}' onto ${cid}`);
    }
    const out = normalizeCanonicalRecord(rec, def, tz, now, log);
    if (out !== rec) {
      result[result.indexOf(rec)] = out;
      changed = true;
    }
  }

  for (let i = 0; i < result.length; i++) {
    const t = result[i];
    const key = t.system?.key;
    if (key != null && !registeredKeys.has(key) && t.system?.enabled !== false) {
      log(`system-reconcile: unknown system key '${key}' on record ${t.id}; force-disabled (record kept, never dispatched)`);
      result[i] = { ...t, system: { key, enabled: false } };
      changed = true;
    }
  }

  return changed ? { tasks: result, changed } : { tasks, changed };
}
