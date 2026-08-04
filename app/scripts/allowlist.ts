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
      version: typeof p.version === "number" ? p.version : 0,
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
