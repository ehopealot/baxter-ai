// Hermetic template-slot coverage, shared by the sms-bot and chat-bot prompt tests:
// every {{TOKEN}} in the named prompt template must have an entry in the slots map,
// so nothing can survive unfilled by drift. Checked on the raw template at the seam,
// never in the filled prompt -- false-failure trap: household names from ambient env
// keep {{...}} byte-intact under the single-pass fill, so a filled-prompt brace scan
// can falsely fail even when every template slot is supplied. The slots map is supplied EAGERLY -- one
// promptSlots() call per call site, the resulting record passed in -- matching the
// runtime's single-map fillTemplate; do not convert to a lazy per-token factory,
// which would mix fresh file-read snapshots.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export function assertTemplateSlots(templateFile: string, slots: Record<string, unknown>): void {
  const tokens = [...readFileSync(join(APP_DIR, templateFile), "utf8").matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
  for (const t of tokens) assert.ok(Object.hasOwn(slots, t), `promptSlots must supply {{${t}}}`);
}
