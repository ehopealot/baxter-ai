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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
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

export interface ThreadIndexEntry {
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
// would silently merge their transcripts. Appending a short hash of
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

// Single-snapshot read of one thread's index entry (correspondent + last
// inbound Message-ID + subject together), so a caller needing more than one
// field -- mail-cli.ts's sendReply needs all three, for the embedded-address
// authorization cross-check AND the In-Reply-To/subject it sends -- reads them
// from the SAME readIndex() call. Three separate getter calls (the original
// shape) could otherwise straddle a concurrent inbound append (mail-bot
// ingest can rewrite this entry between reads), authorizing against one
// index generation while sending headers built from another. Null for an
// unknown thread.
export function threadEntry(threadId: string): ThreadIndexEntry | null {
  return readIndex()[threadId] ?? null;
}

