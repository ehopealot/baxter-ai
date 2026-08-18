// Per-conversation SMS transcript store: one JSONL file per normalized phone
// number under SMS_TRANSCRIPT_DIR. Sendblue has no queryable scrollback, so
// this file *is* the agent's memory of an SMS conversation. Appends are
// cross-process locked (proper-lockfile, same params as checklist-store.ts /
// send-state.ts) because sms-bot (inbound) and sms-cli (outbound) are
// separate processes that can append to the same conversation concurrently.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { SMS_TRANSCRIPT_DIR } from "./paths.ts";
import { normalizePhone } from "./normalize-phone.ts";

// `from` records the SPEAKER on a group inbound (so the prompt can attribute "who said
// what"); it's absent on a 1:1, where the conversation key already is the speaker.
export type TranscriptEntry = { direction: "in" | "out"; at: string; content: string; media_url?: string; from?: string };

function baseDir(): string {
  return process.env.SMS_TRANSCRIPT_DIR_OVERRIDE || SMS_TRANSCRIPT_DIR;
}

// A conversation key is either an E.164 phone (1:1) or `group:<id>` (a group thread). A
// group id is NOT a phone -- normalizePhone would strip it to a digit soup that collides
// or empties -- so group keys get their own filename-safe namespace (`g-<sanitized>`),
// while phone keys keep the exact E.164-digits filename they've always used.
function fileFor(convKey: string): string {
  if (convKey.startsWith("group:")) {
    const safe = convKey.slice(6).replace(/[^A-Za-z0-9._-]/g, "") || "unknown";
    return join(baseDir(), `g-${safe}.jsonl`);
  }
  const norm = normalizePhone(convKey) ?? convKey;
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

// Strictly transcript-file existence: true iff this conversation's JSONL file is on
// disk. The file may now be created either by an inbound append (sms-bot) or by a
// successful first outbound through gatedSend (which owns the outbound transcript
// append) -- so existence does NOT imply the number ever texted in. Its remaining
// callers are transcript-admitted paths: sms-cli's sendGroupSms (a group reply requires
// the group's received transcript) and sendPresence (read receipts + typing indicators
// require a 1:1 transcript, always true for the inbound sender that triggers them) -- a
// direct 1:1 sendSms/sendContactCard is admitted by the household roster instead (see
// sms-cli.ts's admittedRecipient) and does NOT consult this.
export function hasTranscript(phone: string): boolean {
  return existsSync(fileFor(phone));
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
