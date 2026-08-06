// Materialize fleet-wide data-source API keys from the daemon env into the 0600
// keys file data-cli reads (data-cli has NO env fallback). MERGE-preserving so any
// baxter-control-provisioned keys survive; no-op when no relevant env var is set.
// The fleet-wide analog of sms-bot's Sendblue startup write -- invoked once at the
// central runAgent spawn path (data-cli is granted on every surface).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DATA_KEYS_PATH } from "./paths.ts";
import { DATA_SOURCE_KEY_NAMES } from "./data-sources.ts";

export function syncDataKeysFromEnv(env: NodeJS.ProcessEnv = process.env, path: string = env.DATA_KEYS_PATH_OVERRIDE ?? DATA_KEYS_PATH): void {
  const additions: Record<string, string> = {};
  for (const name of DATA_SOURCE_KEY_NAMES) { const v = env[name]; if (v) additions[name] = v; }
  if (Object.keys(additions).length === 0) return; // nothing set; never touch the file
  let current: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`data-keys file at ${path} is not a JSON object`);
    }
    current = parsed as Record<string, string>;
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; } // surface a malformed file
  let changed = false;
  for (const [k, v] of Object.entries(additions)) if (current[k] !== v) { current[k] = v; changed = true; }
  if (!changed) return; // idempotent
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
  renameSync(tmp, path); // atomic; concurrent data-cli readers never see a half file
}
