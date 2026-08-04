// Per-conversation SMS transcript store: one JSONL file per normalized phone
// number under SMS_TRANSCRIPT_DIR. Sendblue has no queryable scrollback, so
// this file *is* the agent's memory of an SMS conversation. Appends are
// cross-process locked (proper-lockfile, same params as checklist-store.ts /
// send-state.ts) because sms-bot (inbound) and sms-cli (outbound) are
// separate processes that can append to the same conversation concurrently.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { SMS_TRANSCRIPT_DIR } from "./paths.ts";
import { normalizePhone } from "./normalize-phone.ts";

export type TranscriptEntry = { direction: "in" | "out"; at: string; content: string; media_url?: string };

function baseDir(): string {
  return process.env.SMS_TRANSCRIPT_DIR_OVERRIDE || SMS_TRANSCRIPT_DIR;
}

function fileFor(phone: string): string {
  const norm = normalizePhone(phone) ?? phone;
  const safe = norm.replace(/[^0-9]/g, "") || "unknown"; // E.164 digits, no '+'
  return join(baseDir(), `${safe}.jsonl`);
}

// Create the transcript file (dir + empty file) if missing, so proper-lockfile
// has an existing target to attach its `.lock` to. Atomic "wx" (fail-if-exists)
// with EEXIST swallowed -- NOT a readFileSync probe-then-create -- because
// sms-bot (inbound append) and sms-cli (outbound append) are separate
// processes that can race the first-ever file create for a new phone number;
// the loser of a read-then-create probe would throw. Mirrors send-state.ts's
// ensureFile.
function ensure(p: string): void {
  mkdirSync(baseDir(), { recursive: true });
  try {
    writeFileSync(p, "", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
  }
}

export async function appendTranscript(phone: string, entry: TranscriptEntry): Promise<void> {
  const p = fileFor(phone);
  ensure(p);
  const release = await lockfile.lock(p, {
    realpath: false, stale: 10000,
    retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
  });
  try {
    appendFileSync(p, JSON.stringify(entry) + "\n");
  } finally {
    await release();
  }
}

export function readTranscript(phone: string, limit?: number): TranscriptEntry[] {
  const p = fileFor(phone);
  let raw = "";
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const entries = raw
    .split("\n")
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as TranscriptEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is TranscriptEntry => e !== null);
  return limit ? entries.slice(-limit) : entries;
}
