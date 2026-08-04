// The shared runtime allow-list (paths.ts ALLOWLIST_PATH). The DO is the source of truth and
// pushes DERIVED address snapshots down the home link; home-bot is the SOLE writer here
// (writeAllowlist). Every surface -- mail.ts's send/receive gates and home-mirror.ts's
// recipientsFromEnv -- reads FRESH on each call via loadAllowlist and NEVER writes (that avoids
// three readers across two containers racing to create the same 0600 file). FAIL-CLOSED is the
// whole contract: a missing/corrupt file falls back to the app.env SEED
// (ALLOWED_SENDERS/ALLOWED_RECIPIENTS), and an empty seed means NOBODY. No path yields "allow
// all". OPERATOR_EMAIL is NOT unioned here -- each caller unions it into recipients itself.
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { ALLOWLIST_PATH } from "./paths.ts";

export interface Allowlist { senders: string[]; recipients: string[]; version: number; }

// A version worth trusting: a non-negative JS-safe integer. Shared by BOTH sides of the
// allowlist's version contract -- this file's own read side (loadAllowlist, below) and
// home-bot.ts's write side (applyMembersCommand's payload guard) -- so the two can't drift
// apart in what they consider a legitimate version, the way they briefly did (the write side
// was tightened first; this read-side gap was the same NaN/Infinity/huge-double/fractional/
// negative class, just reachable via a well-formed-JSON file with an absurd `version` field
// instead of a malformed command payload). A type predicate (not a bare boolean check) so
// callers get `unknown` narrowed to `number` for free, same reasoning as home-link.ts's
// isSafeId. An admitted-but-absurd version here reads as 0 -- the same benign recovery
// documented at loadAllowlist's own version fallback: the next legitimate mutation simply
// re-establishes a good file.
export function isSafeVersion(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

const split = (s?: string): string[] => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

function fromEnv(env: NodeJS.ProcessEnv): Allowlist {
  return { senders: split(env.ALLOWED_SENDERS), recipients: split(env.ALLOWED_RECIPIENTS), version: 0 };
}

export function loadAllowlist(env: NodeJS.ProcessEnv = process.env, path: string = ALLOWLIST_PATH): Allowlist {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (err) {
    // ENOENT is the normal not-yet-provisioned case -- stay silent. Anything else (EACCES,
    // EISDIR, ...) is abnormal for a security-gating file and the env seed it falls back to can
    // be BROADER than the file (e.g. a DO-revoked sender still in a stale ALLOWED_SENDERS), so
    // make it loud.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.error(`allowlist: unreadable ${path} (${(err as Error).message}); falling back to app.env seed`);
    }
    return fromEnv(env); // NEVER allow-all, NEVER writes.
  }
  try {
    const p = JSON.parse(raw) as Partial<Allowlist> | null;
    if (!p || typeof p !== "object" || !Array.isArray(p.senders) || !Array.isArray(p.recipients)) {
      console.error(`allowlist: malformed shape in ${path}; falling back to app.env seed`);
      return fromEnv(env);
    }
    return {
      senders: p.senders.filter((x): x is string => typeof x === "string"),
      recipients: p.recipients.filter((x): x is string => typeof x === "string"),
      // isSafeVersion, not a bare typeof check -- see its own comment. A well-formed-JSON file
      // with an absurd version (1e300, fractional, negative) reads as 0, the same fallback an
      // absent/non-numeric version already got; the write side (home-bot.ts) never persists
      // such a value itself, but this file is also hand-editable (baxctl provisioning, an
      // operator poking the config volume), so the read side must not trust it either.
      version: isSafeVersion(p.version) ? p.version : 0,
    };
  } catch (err) {
    // corrupt JSON -> env fallback, NEVER allow-all -- but loud, per the same broader-seed risk.
    console.error(`allowlist: corrupt JSON in ${path} (${(err as Error).message}); falling back to app.env seed`);
    return fromEnv(env);
  }
}

// Atomic temp+rename, created 0600 from the first write (not chmod'd after) so a crash between
// write and rename never leaves a world-readable temp copy of the address list; baxctl's
// writeEnvVars discipline, reimplemented here because that helper is not importable from core --
// see the plan's cross-repo notes. A failed write/rename unlinks the temp file rather than
// leaking a `.tmp` sibling in STATE_DIR/home for home-bot's watcher to filter.
export function writeAllowlist(list: Allowlist, path: string = ALLOWLIST_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
