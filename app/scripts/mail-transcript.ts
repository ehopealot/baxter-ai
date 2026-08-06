// Per-conversation mail transcript store: one JSONL file per correspondent
// address under MAIL_TRANSCRIPT_DIR, mirroring sms-transcript.ts's structure
// (atomic ensure()/append, *_DIR_OVERRIDE test-isolation seam). Mail differs
// from SMS in one respect: threads. Resend's provider-side thread id needs to
// map back to (a) the last INBOUND Message-ID, so a reply can set
// In-Reply-To/References (closing the gap the AgentMail-era in-memory
// ThreadResolver covered), and (b) the correspondent address, so mail-cli's
// `reply` can re-validate the recipient against the allowlist before sending
// -- see task-5. Both live in a small side index file (thread-index.json),
// atomically written like the per-address transcripts themselves.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { MAIL_TRANSCRIPT_DIR } from "./paths.ts";

export interface MailTranscriptEntry {
  direction: "in" | "out";
  at: string;
  subject: string;
  content: string;
  threadId?: string; // present on inbound
  messageId?: string; // RFC Message-ID, present on inbound
}

interface ThreadIndexEntry {
  messageId?: string;
  from: string;
  subject?: string;
}

type ThreadIndex = Record<string, ThreadIndexEntry>;

function baseDir(): string {
  return process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE || MAIL_TRANSCRIPT_DIR;
}

// Injective filename: the sanitized address alone collides distinct addresses
// (`a.b@x.com` / `a-b@x.com` / `a_b@x.com` all reduce to `a_b_x_com`), which
// would silently merge their transcripts and let hasMailTranscript (the cold-
// outbound gate) answer for the wrong correspondent. Appending a short hash of
// the exact normalized address makes every distinct address land in its own
// file while keeping the prefix human-legible for on-disk debugging.
function fileFor(address: string): string {
  const norm = address.trim().toLowerCase();
  const safe = norm.replace(/[^a-z0-9]/g, "_") || "unknown";
  const hash = createHash("sha256").update(norm).digest("hex").slice(0, 8);
  return join(baseDir(), `${safe}-${hash}.jsonl`);
}

function indexPath(): string {
  return join(baseDir(), "thread-index.json");
}

// Create the transcript/index file (dir + `initial` contents) if missing, so
// proper-lockfile has an existing target to attach its `.lock` to. Atomic "wx"
// (fail-if-exists) with EEXIST swallowed -- NOT a readFileSync probe-then-create
// -- because mail-bot (inbound append) and mail-cli (outbound append) are
// separate processes that can race the first-ever file create for a new
// address/thread. Mirrors sms-transcript.ts's ensure(); `initial` defaults to
// "" for the per-address JSONL transcripts but the index seeds "{}" (valid
// JSON) so readIndex never has to swallow a JSON.parse failure on first touch.
function ensure(p: string, initial = ""): void {
  mkdirSync(baseDir(), { recursive: true });
  try {
    writeFileSync(p, initial, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
  }
}

// Tolerates ONLY "file doesn't exist yet" (ENOENT) and an empty/whitespace
// file (belt-and-suspenders alongside ensure()'s "{}" seed) as "no entries
// yet". Every other failure -- corrupt JSON, EACCES, EMFILE, etc. -- is
// rethrown rather than swallowed into `{}`, because updateIndex's
// read-modify-write would otherwise persist ONLY the new entry and silently
// wipe every other thread's mapping (breaks reply threading AND task-5's
// allowlist re-validation for every thread but the one just written).
function readIndex(): ThreadIndex {
  let raw: string;
  try {
    raw = readFileSync(indexPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw err;
  }
  if (!raw.trim()) return {};
  return JSON.parse(raw) as ThreadIndex;
}

// Atomic temp+rename write, mirroring send-state.ts/chat-transcript.ts's
// writeIndexAtomic -- readers never observe a partially-written index file.
function writeIndexAtomic(index: ThreadIndex): void {
  mkdirSync(baseDir(), { recursive: true });
  const p = indexPath();
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2));
  renameSync(tmp, p);
}

async function updateIndex(threadId: string, entry: ThreadIndexEntry): Promise<void> {
  const p = indexPath();
  ensure(p, "{}");
  const release = await lockfile.lock(p, {
    realpath: false, stale: 10000,
    retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
  });
  try {
    const index = readIndex();
    index[threadId] = entry;
    writeIndexAtomic(index);
  } finally {
    await release();
  }
}

// "Registered" == has an existing transcript file, i.e. this address has an
// on-disk conversation already (mirrors sms-transcript.ts's hasTranscript).
export function hasMailTranscript(address: string): boolean {
  return existsSync(fileFor(address));
}

export async function appendMailTranscript(address: string, entry: MailTranscriptEntry): Promise<void> {
  const p = fileFor(address);
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
  if (entry.direction === "in" && entry.threadId) {
    // subject is stored alongside messageId/from so a reply (mail-cli.ts's
    // sendReply, task-5) can compose "Re: <original subject>" and In-Reply-To/
    // References without depending on the Chat SDK adapter's in-memory
    // ThreadResolver, which has no history in a fresh CLI process.
    await updateIndex(entry.threadId, { messageId: entry.messageId, from: address, subject: entry.subject });
  }
}

export function readMailTranscript(address: string, limit?: number): MailTranscriptEntry[] {
  const p = fileFor(address);
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
        return JSON.parse(line) as MailTranscriptEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is MailTranscriptEntry => e !== null);
  return limit ? entries.slice(-limit) : entries;
}

// Recovers the Message-ID of the most recent INBOUND message on a thread, so
// a reply can set In-Reply-To/References. Undefined if the thread is unknown
// or its last-indexed inbound entry had no messageId.
export function latestInboundMessageId(threadId: string): string | undefined {
  return readIndex()[threadId]?.messageId;
}

// Recovers the correspondent address for a thread, so sendReply (task-5) can
// re-validate the recipient against the allowlist before sending. Null (not
// undefined) for an unknown thread, matching the brief's interface.
export function correspondentForThread(threadId: string): string | null {
  return readIndex()[threadId]?.from ?? null;
}

// Recovers the original subject of a thread (from its last-indexed inbound
// entry), so sendReply (task-5) can compose "Re: <subject>" without relying on
// the Chat SDK adapter's in-memory ThreadResolver (fresh, and history-less, on
// every CLI process). Undefined if the thread is unknown or was indexed before
// this field existed.
export function subjectForThread(threadId: string): string | undefined {
  return readIndex()[threadId]?.subject;
}
