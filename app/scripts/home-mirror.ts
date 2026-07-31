// Family-home web mirror -- the CORE side (see docs/family-home-core-spec.md). The
// checklist store stays the source of truth; the web page is a THIRD reflective mirror of
// it (alongside the CLI and the Discord channel). A control-plane Cloudflare Durable Object
// holds a published copy of the view plus a queue of pending taps; this module publishes
// the view and drains the taps, applying each through the SAME proper-lockfile mutate() the
// CLI uses -- that shared gate is why three writers are safe.
//
// Shape mirrors checklist-mirror.ts exactly: pure functions for the diff/decision, and an
// injectable `HomeOps` seam (one signed POST) so the whole tick is unit-testable against a
// fake and a temp store, with no network. The real signed impl (signedHomeOps) lives at the
// bottom and is verified live, never in the unit tests.
//
// HARD INVARIANT (spec §5, operator-confirmed): draining and applying a tap is plain code
// start to finish. A tap must NEVER wake an LLM run. There are no model calls in this file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AwsClient } from "aws4fetch";
import { readChecklists, mutate } from "./checklist-store.ts";
import type { Checklist } from "./checklist-store.ts";
import { loadState, saveState, freshState } from "./home-state.ts";
import type { HomeState } from "./home-state.ts";
import { HOME_KEYS_PATH } from "./paths.ts";

// ---------- wire types (the contract, spec §Contract) ----------

export interface ViewItem { id: string; text: string; checked: boolean; due: string | null; }
export interface ViewList { slug: string; name: string; open: number; total: number; items: ViewItem[]; }
export interface ViewProject { slug: string; name: string; html: string; }
export interface View { lists: ViewList[]; projects: ViewProject[]; recipients: string[]; }

// Only two intent kinds ever, both idempotent (spec §3).
export interface Intent { id: number; kind: "check" | "uncheck"; listSlug: string; itemId: string; at?: string; }
export interface SyncRequest { viewVersion: string; view?: View; appliedThrough: number; }
export interface SyncResponse { intents?: Intent[]; viewVersion: string | null; pollAfterSeconds?: unknown; }

// The one op the driver supplies (real: a SigV4-signed POST). A non-2xx response is thrown
// as a SyncHttpError carrying the status; 200 returns the parsed body. Tests inject a fake.
export interface HomeOps { sync(body: SyncRequest): Promise<SyncResponse>; }
export class SyncHttpError extends Error {
  status: number;
  constructor(status: number, message?: string) { super(message ?? `HTTP ${status}`); this.name = "SyncHttpError"; this.status = status; }
}

// ---------- pure builders (exported for tests) ----------

// The login allow-list: OPERATOR_EMAIL ∪ ALLOWED_RECIPIENTS from the tenant env, matching
// core's mail send side (resolveRecipient). Deduped case-insensitively and SORTED so this is
// a set semantically -- reordering the env var must not change viewVersion and republish.
// Empty ⇒ nobody can log in (fails closed, exactly like the send side).
export function recipientsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.ALLOWED_RECIPIENTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const op = (env.OPERATOR_EMAIL || "").trim();
  if (op) raw.push(op);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) { const k = r.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(r); } }
  return out.sort();
}

// Build the published view from the store. Only live (non-deleted) lists; items keep the
// store's own ids (the DO addresses taps by listSlug + itemId). `due` is normalized to null.
export function buildView(lists: Checklist[], recipients: string[], projects: ViewProject[]): View {
  const viewLists: ViewList[] = lists
    .filter((l) => !l.deleted)
    .map((l) => {
      const items: ViewItem[] = l.items.map((i) => ({ id: i.id, text: i.text, checked: i.checked, due: i.due ?? null }));
      return { slug: l.slug, name: l.name, open: items.filter((i) => !i.checked).length, total: items.length, items };
    });
  return { lists: viewLists, projects, recipients };
}

// Deterministic serialization: sort object keys recursively, preserve array order. Two views
// that differ only in key insertion order digest the same; any content change (a list, an
// item, a project, OR a recipient) changes the digest. Distinct from a digest of
// checklists.json -- recipients come from env and project HTML from files, so a store-only
// digest would never republish an ALLOWED_RECIPIENTS change (spec §2, the load-bearing point).
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",") + "}";
}
export function viewVersion(view: View): string {
  return createHash("sha256").update(canonicalize(view)).digest("hex");
}
function projectsDigest(projects: ViewProject[]): string {
  return createHash("sha256").update(canonicalize(projects)).digest("hex");
}

// Resolve the DO-supplied pollAfterSeconds to a delay in ms, clamped to [2s, 60s]. A finite
// number clamps; anything else (absent, NaN, non-number) falls back to the idle rung -- 60s
// once a response has arrived, 30s before the first one. NEVER a 0-delay hot loop (the clamp
// alone misses this: Math.max(2, undefined) is NaN and setTimeout(NaN) fires immediately) and
// NEVER holding a stale 2s (spec §Contract pollAfterSeconds).
export function resolvePollAfterMs(raw: unknown, hasResponded: boolean): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.min(60000, Math.max(2000, Math.round(raw * 1000)));
  return hasResponded ? 60000 : 30000;
}

// ---------- applying a tap (through the shared checklist lock) ----------

// Apply one check/uncheck through the SAME mutate() the CLI uses. Idempotent, and a no-op if
// the list or item is gone (the operator deleted it; the tap is moot -- exactly as a removed
// item's reminder self-cancels). Never throws for a missing target.
export async function applyIntent(path: string, intent: Intent): Promise<void> {
  await mutate(path, (lists) => {
    const list = lists.find((l) => l.slug === intent.listSlug && !l.deleted);
    const item = list?.items.find((i) => i.id === intent.itemId);
    if (item && list) {
      const checked = intent.kind === "check";
      if (item.checked !== checked) {
        item.checked = checked;
        if (checked) item.checkedAt = intent.at || new Date().toISOString();
        else delete item.checkedAt;
        list.updated = new Date().toISOString();
      }
    }
    return { lists, value: null };
  });
}

// ---------- the sync tick ----------

const HOUR_MS = 3_600_000;
const BACKOFF_START_MS = 30_000;
const BACKOFF_CAP_MS = 300_000; // 5 minutes
// Sentinel: a fatal config error (403 tenant mismatch) tells the driver to STOP the loop.
export const STOP_SYNCING = -1;

export interface TickDeps {
  ops: HomeOps;
  checklistsPath: string;
  statePath: string;
  buildProjects: () => ViewProject[]; // v1 stub: () => []. The latch logic below is real regardless.
  env: NodeJS.ProcessEnv;
  now: () => number;
  log: (m: string) => void;
  logErr: (m: string) => void;
  alert: (m: string) => void; // loud, operator-facing (a distinctive log line in v1)
}

// In-memory runtime the driver owns ACROSS ticks -- deliberately NOT persisted. A restart
// resetting backoff/hasResponded/forceRepublish costs at most one extra tick, and the echoed
// version re-detects DO state loss anyway. (Only appliedThrough + the latches are durable.)
export interface TickMemo {
  hasResponded: boolean;
  failureBackoffMs: number;
  consecutive401: number;
  forceRepublish: boolean;
}
export function freshMemo(): TickMemo {
  return { hasResponded: false, failureBackoffMs: 0, consecutive401: 0, forceRepublish: false };
}

// One sync tick: build the view (honoring the 413 latches), publish it if it changed (or a
// prior echo mismatch forces it), apply every returned intent in id order, and return the ms
// delay before the next tick. Everything durable is persisted here; the memo carries the
// in-process runtime. Returns STOP_SYNCING on a fatal 403.
export async function runSyncTick(deps: TickDeps, memo: TickMemo): Promise<number> {
  const now = deps.now();
  const state = loadState(deps.statePath);
  const lists = readChecklists(deps.checklistsPath);
  const recipients = recipientsFromEnv(deps.env);

  const builtProjects = deps.buildProjects();
  const builtDigest = projectsDigest(builtProjects);

  // Projects 413-latch (spec §Contract 413): while a freshly-built projects array digests to
  // the recorded oversized one, publish with projects:[] instead of resending it. Re-probed
  // hourly so an innocent projects array latched by a lists-caused 413 is not stuck forever.
  const projectsLatchElapsed = state.projectsLatchAt !== null && now - state.projectsLatchAt >= HOUR_MS;
  const projectsLatched = state.oversizedProjectsDigest !== null
    && state.oversizedProjectsDigest === builtDigest && !projectsLatchElapsed;
  const projects = projectsLatched ? [] : builtProjects;

  const view = buildView(lists, recipients, projects);
  const currentVersion = viewVersion(view);
  // baseVersion keys the doubly-413 (pubFatal) latch: the version of the projects-independent
  // view, so "the built view's digest changed" (retry a full publish) reduces to a lists change.
  const baseVersion = viewVersion(buildView(lists, recipients, []));

  const pubFatalElapsed = state.pubFatalAt !== null && now - state.pubFatalAt >= HOUR_MS;
  const pubFatal = state.pubFatalVersion !== null && state.pubFatalVersion === baseVersion && !pubFatalElapsed;

  // Send the view when forced (a DO state-loss echo last tick) or when it changed since the
  // last SUCCESSFUL publish -- unless we're in pubFatal drain-only (the publish path is
  // known-broken; keep draining taps, which is the more important half of /api/sync).
  const wantPublish = memo.forceRepublish || currentVersion !== state.publishedVersion;
  const sendView = wantPublish && !pubFatal;

  let res: SyncResponse;
  try {
    if (sendView) {
      try {
        res = await deps.ops.sync({ viewVersion: currentVersion, view, appliedThrough: state.appliedThrough });
        state.publishedVersion = currentVersion;
        // A publish that INCLUDED the real projects (not the stripped []) clears their latch.
        if (!projectsLatched && state.oversizedProjectsDigest === builtDigest) { state.oversizedProjectsDigest = null; state.projectsLatchAt = null; }
        state.pubFatalVersion = null; state.pubFatalAt = null; // the view fit
      } catch (err) {
        if (!(err instanceof SyncHttpError) || err.status !== 413) throw err;
        res = await handle413(deps, state, now, lists, recipients, projects, builtDigest, baseVersion, currentVersion);
      }
    } else {
      res = await deps.ops.sync({ viewVersion: currentVersion, appliedThrough: state.appliedThrough }); // drain-only
    }
  } catch (err) {
    return handleSyncError(err, deps, memo, state, now);
  }

  // --- 200 OK ---
  memo.hasResponded = true;
  memo.failureBackoffMs = 0;
  memo.consecutive401 = 0;

  // Echoed version = the version the DO currently holds. A mismatch (or null) is the only
  // signal that DO state was lost; a null echo means it holds NO view (storage gone) -- which
  // also loses the recipients list, so also reset appliedThrough (the 409 counter check has a
  // boundary hole the null echo does not; spec §Contract response viewVersion).
  memo.forceRepublish = false;
  if (res.viewVersion === null) {
    memo.forceRepublish = true;
    if (state.appliedThrough !== 0) { deps.log("home: DO echoed null viewVersion (storage lost) -- resetting appliedThrough to 0 and republishing"); state.appliedThrough = 0; }
  } else if (res.viewVersion !== state.publishedVersion) {
    memo.forceRepublish = true;
  }

  saveState(state, deps.statePath);

  // Apply intents strictly in id order, persisting appliedThrough AFTER EACH (not the batch),
  // so a crash duplicates at most one idempotent tap. Gaps in ids are normal (bounded queue).
  const intents = (res.intents ?? []).filter((i) => i.id > state.appliedThrough).sort((a, b) => a.id - b.id);
  for (const intent of intents) {
    await applyIntent(deps.checklistsPath, intent);
    state.appliedThrough = intent.id;
    saveState(state, deps.statePath);
  }

  return resolvePollAfterMs(res.pollAfterSeconds, true);
}

// A 413 on a publish. Two cases (spec §Contract 413):
//  A. the view carried real projects -> latch them, republish stripped (projects:[]) THIS tick.
//  B. the stripped view (or a view that already had projects:[]) is ALSO too big -> the lists
//     themselves overflow: record pubFatal and drain-only (view omitted). Do NOT latch the
//     stripped array as the oversized-projects digest (that would oscillate the latch).
// Returns the SyncResponse of whichever follow-up sync succeeded (may itself throw, e.g. a
// network error on the retry, which propagates to handleSyncError).
async function handle413(
  deps: TickDeps, state: HomeState, now: number,
  lists: Checklist[], recipients: string[], projects: ViewProject[],
  builtDigest: string, baseVersion: string, currentVersion: string,
): Promise<SyncResponse> {
  if (projects.length > 0) {
    // Case A: real projects too large. Latch + persist (crash-safe) before the retry.
    state.oversizedProjectsDigest = builtDigest;
    state.projectsLatchAt = now;
    saveState(state, deps.statePath);
    deps.alert("home: view exceeded the DO size cap (413) -- publishing projects:[] and latching projects until they change");
    const strippedView = buildView(lists, recipients, []);
    const strippedVersion = viewVersion(strippedView); // == baseVersion
    try {
      const res = await deps.ops.sync({ viewVersion: strippedVersion, view: strippedView, appliedThrough: state.appliedThrough });
      state.publishedVersion = strippedVersion;
      state.pubFatalVersion = null; state.pubFatalAt = null;
      return res;
    } catch (err2) {
      if (!(err2 instanceof SyncHttpError) || err2.status !== 413) throw err2;
      // Case B via A: the stripped view is ALSO too big.
    }
  }
  // Case B: the checklists themselves overflow. Drain-only, keep the last accepted view.
  state.pubFatalVersion = baseVersion;
  state.pubFatalAt = now;
  saveState(state, deps.statePath);
  deps.alert("home: even projects:[] exceeded the DO size cap (413) -- the checklists are too large to publish; draining taps only until they shrink");
  return deps.ops.sync({ viewVersion: currentVersion, appliedThrough: state.appliedThrough }); // view omitted; publishedVersion unchanged
}

// Non-2xx / network handling. 403 stops the loop; 409 resets the counter; 401/429/network
// back off exponentially. Returns the ms delay before the next tick (or STOP_SYNCING).
function handleSyncError(err: unknown, deps: TickDeps, memo: TickMemo, state: HomeState, now: number): number {
  const status = err instanceof SyncHttpError ? err.status : 0;

  if (status === 403) {
    deps.alert("home: 403 tenant mismatch -- fatal config error (check home-keys.json `tenant`); stopping the home sync loop");
    return STOP_SYNCING;
  }
  if (status === 409) {
    // The DO's queue was reset while STATE_DIR kept counting -> reset appliedThrough and retry;
    // redelivery is free (check/uncheck are idempotent). Not a rate/credential failure.
    if (state.appliedThrough !== 0) { state.appliedThrough = 0; saveState(state, deps.statePath); }
    deps.log("home: 409 (DO queue was reset) -- reset appliedThrough to 0; will redeliver idempotently next tick");
    memo.failureBackoffMs = 0;
    return resolvePollAfterMs(undefined, memo.hasResponded);
  }
  if (status === 401) {
    memo.consecutive401 += 1;
    if (memo.consecutive401 === 10) deps.alert("home: 10 consecutive 401s -- the credential is likely wrong or unregistered (re-run `baxctl home <id>` on the box). Still retrying.");
  }
  // 401 / 429 / network / unknown -> exponential backoff 30s..5min, reset on the first 200.
  memo.failureBackoffMs = memo.failureBackoffMs === 0 ? BACKOFF_START_MS : Math.min(memo.failureBackoffMs * 2, BACKOFF_CAP_MS);
  deps.logErr(`home: sync failed (${status ? "HTTP " + status : "network error"}) -- backing off ${Math.round(memo.failureBackoffMs / 1000)}s`);
  return memo.failureBackoffMs;
}

// ---------- credentials + the real signed op (verified live, not unit-tested) ----------

export interface HomeKeys { endpoint: string; tenant: string; accessKeyId: string; secretAccessKey: string; }

// Read home-keys.json. Throws ENOENT (caller idles the surface) or a descriptive error on a
// malformed file. Placement/shape class matches calendar-cli's loadKeys.
export function loadHomeKeys(path: string = HOME_KEYS_PATH): HomeKeys {
  const raw = readFileSync(path, "utf8");
  const k = JSON.parse(raw) as Partial<HomeKeys>;
  for (const f of ["endpoint", "tenant", "accessKeyId", "secretAccessKey"] as const) {
    if (!k[f]) throw new Error(`home-keys.json is missing "${f}"`);
  }
  return k as HomeKeys;
}

// The real HomeOps: one AWS SigV4 POST to {endpoint}/api/sync, service "home" (NOT "s3", so a
// calendar signature can never be replayed here -- and, being non-s3, aws4fetch covers the
// body in the signature rather than sending UNSIGNED-PAYLOAD; see the spec's signing note).
// Content-Type is safe to set: aws4fetch treats it as UNSIGNABLE, so SignedHeaders stays
// host;x-amz-date. Do NOT add x-amz-content-sha256 -- it would change the canonical request.
export function signedHomeOps(keys: HomeKeys): HomeOps {
  const aws = new AwsClient({ accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, region: "auto", service: "home" });
  const url = `${keys.endpoint.replace(/\/+$/, "")}/api/sync`;
  return {
    async sync(body: SyncRequest): Promise<SyncResponse> {
      const res = await aws.fetch(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      if (res.status === 200) return (await res.json()) as SyncResponse;
      throw new SyncHttpError(res.status, (await res.text().catch(() => "")).slice(0, 200));
    },
  };
}

// Re-exported so the driver imports state helpers from one place.
export { loadState, saveState, freshState };
export type { HomeState };
