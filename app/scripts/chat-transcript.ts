// Home Chats store: a chat index (CHATS_DIR/index.json) plus one JSONL message
// log per chat (CHATS_DIR/<id>/messages.jsonl). The container is the source of
// truth for chat content -- the chat-link (Phase 2) publishes both up to the
// browser, but this file owns the on-disk state.
//
// Mirrors sms-transcript.ts's structure (baseDir() override hook, the atomic
// `ensure()` pattern, proper-lockfile with the same params) but adds an index
// alongside the per-chat logs -- SMS has no equivalent because one file IS the
// whole conversation, whereas a chat needs to be listable. The index is
// locked separately from each chat's message log (checklist-store.ts's
// read-transform-atomic-write `mutate` pattern, scoped to CHATS_DIR/index.json)
// because createChat/setTitle only ever touch the index, while appendMessage
// touches both (the message log AND the index's `lastAt`).
//
// createChat is idempotent on the deterministic id `wc-<intentId>` (mirrors
// home-mirror.ts's `wi-<id>`), so a redelivered create-chat intent -- or the
// bot and another caller racing the first-ever create for a chat -- is a safe
// no-op rather than a duplicate index entry.
import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeFileSync, writeSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import lockfile from "proper-lockfile";
import { ensureDurableDirectory, syncDirectory } from "./durable-directory.ts";
import { CHATS_DIR } from "./paths.ts";

export type ChatAuthor = `member:${string}` | "baxter";
export type ChatMessage = { id: string; at: string; authorId: ChatAuthor; authorName: string; content: string };
export type ChatMeta = { id: string; title: string | null; createdAt: string; lastAt: string; deletedAt?: string };

/** A deterministic semantic conflict is safe to dead-letter; storage failures are not. */
export class ChatTranscriptPermanentError extends Error {
  readonly permanent = true;
  constructor(message: string) { super(message); this.name = "ChatTranscriptPermanentError"; }
}
export function isPermanentChatTranscriptError(error: unknown): boolean {
  return error instanceof ChatTranscriptPermanentError;
}

function baseDir(): string {
  return process.env.CHATS_DIR_OVERRIDE || CHATS_DIR;
}

let syncFile = fsyncSync;
/** Narrow durability fault seam; production always uses fsyncSync. */
export function setChatTranscriptFsyncForTest(replacement: (fd: number) => void): () => void {
  const previous = syncFile;
  syncFile = replacement;
  return () => { syncFile = previous; };
}

// `<id>` ends up in a path (both as the index key and as the per-chat
// subdirectory name), so it MUST be validated before any path use. Accepts the
// deterministic `wc-<n>` shape (home-mirror.ts's `wi-<id>`, here `wc-<intentId>`)
// or a minted baxter id (checklist-store.ts's newItemId(): 16+ lowercase hex
// chars) -- anything else (e.g. `../../etc`) is rejected so it can never reach
// join() as a path segment.
const CHAT_ID_RE = /^(wc-\d+|[0-9a-f]{16,})$/;

function validateId(id: string): void {
  if (!CHAT_ID_RE.test(id)) throw new Error(`invalid chat id: ${id}`);
}

// Exported for link-cli (and any future caller) to check a chat id's shape without
// throwing -- the same CHAT_ID_RE validateId enforces. Single source of truth.
export function isValidChatId(id: string): boolean {
  return CHAT_ID_RE.test(id);
}

function indexPath(): string {
  return join(baseDir(), "index.json");
}

function chatDir(id: string): string {
  return join(baseDir(), id);
}

function messagesPath(id: string): string {
  return join(chatDir(id), "messages.jsonl");
}

// Atomic "wx" (fail-if-exists) create with EEXIST swallowed -- NOT a
// readFileSync probe-then-create -- so two racing first-writers never throw.
// A new pathname is not treated as committed until its directory ancestry,
// file contents, and containing directory have crossed fsync barriers.
function ensure(p: string, initial: string): void {
  const directory = dirname(p);
  ensureDurableDirectory(directory);
  let fd: number | undefined;
  try {
    fd = openSync(p, "wx", 0o600);
    writeFileSync(fd, initial);
    syncFile(fd);
    closeSync(fd); fd = undefined;
    syncDirectory(directory);
  } catch (err) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
  }
}

function readIndex(): ChatMeta[] {
  try {
    return JSON.parse(readFileSync(indexPath(), "utf8")) as ChatMeta[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

function writeIndexAtomic(list: ChatMeta[]): void {
  const p = indexPath();
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(list, null, 2));
    syncFile(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, p);
  syncDirectory(dirname(p));
}

function isChatMessageRow(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.at === "string"
    && typeof row.authorName === "string" && typeof row.content === "string"
    && typeof row.authorId === "string" && (row.authorId === "baxter" || row.authorId.startsWith("member:"));
}

function parseRows(raw: string): ChatMessage[] {
  if (raw !== "" && !raw.endsWith("\n")) throw new Error("partial trailing transcript row");
  return raw.split("\n").filter(Boolean).map((line, index) => {
    try {
      const value: unknown = JSON.parse(line);
      if (isChatMessageRow(value)) return value;
    } catch {}
    throw new Error(`corrupt transcript row ${index + 1}`);
  });
}

/**
 * A crash before a row fsync can leave one unterminated tail. A complete JSON
 * value only needs its missing newline repaired; an incomplete value is rolled
 * back to the preceding durable row. Newline-terminated corruption is never
 * silently discarded.
 */
function repairPartialTail(path: string): ChatMessage[] {
  let raw = readFileSync(path, "utf8");
  if (raw !== "" && !raw.endsWith("\n")) {
    const boundary = raw.lastIndexOf("\n") + 1;
    const tail = raw.slice(boundary);
    let parsed = false;
    let value: unknown;
    try { value = JSON.parse(tail); parsed = true; } catch {}
    if (parsed && !isChatMessageRow(value)) throw new Error("corrupt partial transcript row");
    const complete = parsed;
    const fd = openSync(path, "r+");
    try {
      if (complete) {
        const newline = Buffer.from("\n");
        let offset = 0;
        const position = Buffer.byteLength(raw);
        while (offset < newline.length) offset += writeSync(fd, newline, offset, newline.length - offset, position + offset);
        raw += "\n";
      } else {
        ftruncateSync(fd, Buffer.byteLength(raw.slice(0, boundary)));
        raw = raw.slice(0, boundary);
      }
      syncFile(fd);
    } finally { closeSync(fd); }
    syncDirectory(dirname(path));
  }
  return parseRows(raw);
}

function syncDurableFile(path: string): void {
  const fd = openSync(path, "r");
  try { syncFile(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}

function appendDurableRow(path: string, row: string): void {
  const fd = openSync(path, "a");
  try {
    const bytes = Buffer.from(row);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new Error("transcript row write made no progress");
      offset += written;
    }
    syncFile(fd);
  } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}

// Read -> transform -> atomically write, under a proper-lockfile lock WITH
// `retries` -- shared by createChat/setTitle (index-only) and appendMessage's
// `lastAt` bump. The retrying async lock is deliberate, NOT the no-retry sync
// `lockSync` (proper-lockfile forbids combining `retries` with the sync adapter:
// "Cannot use retries with the sync api" -- lib/adapter.js's toSyncOptions).
// The index lock is held briefly by EVERY appendMessage `lastAt` bump --
// including from the separate chat-cli process on every Baxter reply, in ANY
// chat -- so a create-chat/setTitle landing during a bump would hit ELOCKED
// under a no-retry sync lock. That is not a cosmetic delay: an ELOCKED out of
// createChat propagates through chat-bot.ts's handleIntent, which then stores
// neither the cursor nor an ack, so the next intent that DOES succeed acks the
// failed id away and moves the cursor past it -- the create-chat can never be
// redelivered, the chat is never created, and every later send-message for it
// then fails appendMessage's "no index entry" check the same way (a cascading,
// permanent loss from one transient lock collision). Backing off and retrying
// (same contention-absorbing profile as checklist-store.ts's async mutate())
// is what prevents it. Both call sites (handleIntent, maybeTitle's `.then`) are
// already async, so nothing here needs a synchronous variant.
async function mutateIndex<V>(fn: (list: ChatMeta[]) => { list: ChatMeta[]; value: V }): Promise<V> {
  ensure(indexPath(), "[]");
  const release = await lockfile.lock(indexPath(), {
    realpath: false, stale: 10000,
    retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
  });
  try {
    const current = readIndex();
    const { list, value } = fn(current);
    writeIndexAtomic(list);
    return value;
  } finally {
    await release();
  }
}

export function listChats(): ChatMeta[] {
  return readIndex().filter(c => !c.deletedAt);
}

export async function createChat(id: string, now: string): Promise<void> {
  validateId(id);
  await mutateIndex(list => {
    if (list.some(c => c.id === id)) return { list, value: undefined };
    return { list: [...list, { id, title: null, createdAt: now, lastAt: now }], value: undefined };
  });
}

// Tombstone a chat without touching its messages log. Repeated deletes and deletes
// for unknown ids are harmless, so redelivered intents remain idempotent.
export async function deleteChat(id: string): Promise<void> {
  validateId(id);
  await mutateIndex(list => {
    const existing = list.find(c => c.id === id);
    if (!existing || existing.deletedAt) return { list, value: undefined };
    return {
      list: list.map(c => (c.id === id ? { ...c, deletedAt: new Date().toISOString() } : c)),
      value: undefined,
    };
  });
}

export async function setTitle(id: string, title: string): Promise<void> {
  validateId(id);
  await mutateIndex(list => ({
    list: list.map(c => (c.id === id ? { ...c, title } : c)),
    value: undefined,
  }));
}

/** Set an automatic title without overwriting a title won by another writer. */
export async function setTitleIfUntitled(id: string, title: string): Promise<string | null> {
  validateId(id);
  return mutateIndex(list => {
    const entry = list.find(c => c.id === id);
    if (!entry) throw new ChatTranscriptPermanentError(`setTitle: chat ${id} has no index entry`);
    if (entry.deletedAt) throw new ChatTranscriptPermanentError(`setTitle: chat ${id} was deleted`);
    if (entry.title !== null) return { list, value: entry.title };
    return { list: list.map(c => c.id === id ? { ...c, title } : c), value: title };
  });
}

export async function appendMessage(id: string, m: ChatMessage): Promise<void> {
  validateId(id);
  // Check the index BEFORE touching the log, not just as a backstop after --
  // index entries are only ever added (createChat appends; setTitle/the
  // lastAt bump below only map existing entries in place, nothing removes),
  // so an unlocked pre-check that passes can never be invalidated by a
  // concurrent mutation. Ordering this after the log append would still
  // create the orphan messages.jsonl the check exists to prevent (the throw
  // would just make it noisy instead of silent).
  const entry = readIndex().find(c => c.id === id);
  if (!entry) {
    throw new ChatTranscriptPermanentError(`appendMessage: chat ${id} has no index entry (createChat was never called)`);
  }
  if (entry.deletedAt) {
    throw new ChatTranscriptPermanentError(`appendMessage: chat ${id} was deleted`);
  }
  const p = messagesPath(id);
  ensure(p, "");
  const release = await lockfile.lock(p, {
    realpath: false, stale: 10000,
    retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
  });
  try {
    // Re-check deletedAt under the message-file lock, immediately before the write —
    // collapses the TOCTOU window from "however long lock acquisition takes" (up to 30
    // retries × 30-300ms) down to a synchronous gap. chat-cli.ts (Baxter's reply path,
    // a separate process outside chat-bot's serialized intent chain) calls appendMessage,
    // so a concurrent deleteChat can tombstone between the unlocked pre-check above and
    // here; without this re-check the line would be on disk before the locked re-check
    // in mutateIndex below catches it.
    const lockedEntry = readIndex().find(c => c.id === id);
    if (!lockedEntry) throw new ChatTranscriptPermanentError(`appendMessage: chat ${id} has no index entry (createChat was never called)`);
    if (lockedEntry.deletedAt) throw new ChatTranscriptPermanentError(`appendMessage: chat ${id} was deleted`);

    // Queue redelivery can follow a crash after this append but before the index
    // bump or outbox admission. The source sequence supplies a deterministic ID;
    // decide idempotency while holding the same lock as the append. A changed
    // payload under one ID is poison rather than a second transcript row.
    const matches = repairPartialTail(p).filter(value => value.id === m.id);
    if (matches.length) {
      if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(m)) {
        throw new ChatTranscriptPermanentError(`appendMessage: message ${m.id} conflicts with its durable transcript row`);
      }
      // The first attempt may have exposed bytes before its fsync failed. A
      // reconciled redelivery must establish that missing durability barrier.
      syncDurableFile(p);
    } else {
      appendDurableRow(p, JSON.stringify(m) + "\n");
    }
  } finally {
    await release();
  }
  // Bump the chat's lastAt in the index under its own (separate) lock -- the
  // index and the per-chat log are independent lock domains, same as their
  // separate ensure()/mutate targets above. Uses the retryable async lock
  // (the same mutateIndex createChat/setTitle now route through) since a message was already durably appended above;
  // failing this step outright on lock contention would strand that message
  // unindexed rather than just delaying the bump. The bump is monotonic
  // (keeps whichever timestamp is chronologically later, compared numerically
  // via Date.parse -- NOT a plain string compare, which breaks across mixed
  // timestamp precision, e.g. millisecond- vs second-precision ISO strings)
  // because two concurrent appends to the same chat can have their index
  // bumps land in the opposite order from their log appends. The index entry
  // itself may have been deleted-then-recreated between the pre-check above
  // and here only if something starts deleting entries in the future (nothing
  // does today), so this re-checks rather than assuming the pre-check result
  // still holds.
  await mutateIndex(list => {
    const entry = list.find(c => c.id === id);
    if (!entry) {
      throw new ChatTranscriptPermanentError(`appendMessage: chat ${id} has no index entry (createChat was never called)`);
    }
    if (entry.deletedAt) {
      throw new ChatTranscriptPermanentError(`appendMessage: chat ${id} was deleted`);
    }
    return {
      list: list.map(c =>
        c.id === id ? { ...c, lastAt: Date.parse(m.at) > Date.parse(c.lastAt) ? m.at : c.lastAt } : c
      ),
      value: undefined,
    };
  });
}

export function readMessages(id: string, limit?: number): ChatMessage[] {
  validateId(id);
  let raw = "";
  try {
    raw = readFileSync(messagesPath(id), "utf8");
  } catch {
    return [];
  }
  const messages = parseRows(raw);
  return limit ? messages.slice(-limit) : messages;
}
