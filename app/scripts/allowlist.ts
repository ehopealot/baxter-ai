// The shared runtime allow-list (paths.ts ALLOWLIST_PATH). The DO is the source of truth and
// pushes DERIVED address snapshots down the home link; home-bot is the SOLE writer here
// (writeAllowlist). Every surface -- mail.ts's send/receive gates and home-mirror.ts's
// recipientsFromEnv -- reads FRESH on each call via loadAllowlist and NEVER writes (that avoids
// three readers across two containers racing to create the same 0600 file). FAIL-CLOSED is the
// whole contract: a missing/corrupt file falls back to the app.env SEED
// (ALLOWED_SENDERS/ALLOWED_RECIPIENTS), and an empty seed means NOBODY. No path yields "allow
// all". OPERATOR_EMAIL is NOT unioned here -- each caller unions it into recipients itself.
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from "node:fs";
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
  catch { return fromEnv(env); } // ENOENT/EACCES/... -> env seed. NEVER allow-all, NEVER writes.
  try {
    const p = JSON.parse(raw) as Partial<Allowlist> | null;
    if (!p || typeof p !== "object" || !Array.isArray(p.senders) || !Array.isArray(p.recipients)) return fromEnv(env);
    return {
      senders: p.senders.filter((x): x is string => typeof x === "string"),
      recipients: p.recipients.filter((x): x is string => typeof x === "string"),
      version: typeof p.version === "number" ? p.version : 0,
    };
  } catch {
    return fromEnv(env); // corrupt JSON -> env fallback, NEVER allow-all.
  }
}

// Atomic temp+rename + chmod 0600 (baxctl's writeEnvVars discipline, reimplemented here because
// that helper is not importable from core -- see the plan's cross-repo notes).
export function writeAllowlist(list: Allowlist, path: string = ALLOWLIST_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
