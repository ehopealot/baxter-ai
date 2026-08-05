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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import lockfile from "proper-lockfile";
import { CHATS_DIR } from "./paths.ts";

export type ChatAuthor = `member:${string}` | "baxter";
export type ChatMessage = { id: string; at: string; authorId: ChatAuthor; authorName: string; content: string };
export type ChatMeta = { id: string; title: string | null; createdAt: string; lastAt: string };

function baseDir(): string {
  return process.env.CHATS_DIR_OVERRIDE || CHATS_DIR;
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
// readFileSync probe-then-create -- so two racing first-writers (e.g. the
// chat-link bot and a redelivered intent) never throw. Mirrors
// sms-transcript.ts's ensure() / checklist-store.ts's ensureFile().
function ensure(p: string, initial: string): void {
  mkdirSync(dirname(p), { recursive: true });
  try {
    writeFileSync(p, initial, { flag: "wx" });
  } catch (err) {
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
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, p);
}

// Read -> transform -> atomically write, under a proper-lockfile lock (sync
// variant -- createChat/setTitle are synchronous per the interface, so this
// uses lockSync rather than sms-transcript.ts's async lock). Same
// `realpath`/`stale` params as the async lock below, but WITHOUT `retries`:
// proper-lockfile's sync adapter rejects a nonzero `retries` outright
// ("Cannot use retries with the sync api" -- lib/adapter.js's toSyncOptions),
// since honoring retries would require the async flow the sync API exists to
// avoid. So a sync lock attempt that's currently held throws immediately
// instead of backing off; index critical sections here are a short
// read-modify-write, same contention profile as checklist-store.ts's mutate().
function mutateIndexSync<V>(fn: (list: ChatMeta[]) => { list: ChatMeta[]; value: V }): V {
  ensure(indexPath(), "[]");
  const release = lockfile.lockSync(indexPath(), { realpath: false, stale: 10000 });
  try {
    const current = readIndex();
    const { list, value } = fn(current);
    writeIndexAtomic(list);
    return value;
  } finally {
    release();
  }
}

export function listChats(): ChatMeta[] {
  return readIndex();
}

export function createChat(id: string, now: string): void {
  validateId(id);
  mutateIndexSync(list => {
    if (list.some(c => c.id === id)) return { list, value: undefined };
    return { list: [...list, { id, title: null, createdAt: now, lastAt: now }], value: undefined };
  });
}

export function setTitle(id: string, title: string): void {
  validateId(id);
  mutateIndexSync(list => ({
    list: list.map(c => (c.id === id ? { ...c, title } : c)),
    value: undefined,
  }));
}

export async function appendMessage(id: string, m: ChatMessage): Promise<void> {
  validateId(id);
  const p = messagesPath(id);
  ensure(p, "");
  const release = await lockfile.lock(p, {
    realpath: false, stale: 10000,
    retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
  });
  try {
    appendFileSync(p, JSON.stringify(m) + "\n");
  } finally {
    await release();
  }
  // Bump the chat's lastAt in the index under its own (separate) lock -- the
  // index and the per-chat log are independent lock domains, same as their
  // separate ensure()/mutate targets above.
  mutateIndexSync(list => ({
    list: list.map(c => (c.id === id ? { ...c, lastAt: m.at } : c)),
    value: undefined,
  }));
}

export function readMessages(id: string, limit?: number): ChatMessage[] {
  validateId(id);
  let raw = "";
  try {
    raw = readFileSync(messagesPath(id), "utf8");
  } catch {
    return [];
  }
  const messages = raw
    .split("\n")
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as ChatMessage;
      } catch {
        return null;
      }
    })
    .filter((e): e is ChatMessage => e !== null);
  return limit ? messages.slice(-limit) : messages;
}
