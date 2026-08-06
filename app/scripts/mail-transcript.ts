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
}

type ThreadIndex = Record<string, ThreadIndexEntry>;

function baseDir(): string {
  return process.env.MAIL_TRANSCRIPT_DIR_OVERRIDE || MAIL_TRANSCRIPT_DIR;
}

function fileFor(address: string): string {
  const safe = address.trim().toLowerCase().replace(/[^a-z0-9]/g, "_") || "unknown";
  return join(baseDir(), `${safe}.jsonl`);
}

function indexPath(): string {
  return join(baseDir(), "thread-index.json");
}

// Create the transcript file (dir + empty file) if missing, so proper-lockfile
// has an existing target to attach its `.lock` to. Atomic "wx" (fail-if-exists)
// with EEXIST swallowed -- NOT a readFileSync probe-then-create -- because
// mail-bot (inbound append) and mail-cli (outbound append) are separate
// processes that can race the first-ever file create for a new address.
// Mirrors sms-transcript.ts's ensure().
function ensure(p: string): void {
  mkdirSync(baseDir(), { recursive: true });
  try {
    writeFileSync(p, "", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
  }
}

function readIndex(): ThreadIndex {
  try {
    return JSON.parse(readFileSync(indexPath(), "utf8")) as ThreadIndex;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    return {};
  }
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
  ensure(p);
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
    await updateIndex(entry.threadId, { messageId: entry.messageId, from: address });
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
