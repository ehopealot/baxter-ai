// Vendored SQLite state adapter for the Vercel Chat SDK, ported from the MIT
// `chat-state-cloudflare-do` package's DurableObject SQL schema/logic.
//
// Substitutions from the source:
//  - DO atomicity -> better-sqlite3 runs synchronously in one Node process
//    (single-writer, one container), so there are no cross-instance races to
//    guard against with an explicit transaction wrapper for most ops.
//  - Alarms-API TTL sweep -> TTLs are checked lazily on read
//    (`WHERE expires_at IS NULL OR expires_at > @now`) plus an opportunistic
//    `DELETE ... WHERE expires_at <= @now` sweep run at the top of each
//    mutating call.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { StateAdapter, Lock, QueueEntry } from "chat";

/**
 * Chat marks a message dedupe key before invoking the surface handler.  Mail
 * keeps that write in a SQLite transaction until the awaited handler has
 * durably admitted the queue envelope.  A throw (or process crash) rolls the
 * key back, so provider redelivery can try admission again instead of being
 * mistaken for an already-admitted duplicate.
 */
export interface MailStateAdapter extends StateAdapter {
  beginAdmission(): void;
  commitAdmission(): void;
  rollbackAdmission(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscriptions (thread_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS locks (
  thread_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
  entry TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS queue_thread ON queue(thread_id, id);
CREATE TABLE IF NOT EXISTS lists (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, value TEXT NOT NULL,
  expires_at INTEGER);
CREATE INDEX IF NOT EXISTS lists_key ON lists(key, seq);
`;

export function createMailState(dbPath: string): MailStateAdapter {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  const now = () => Date.now();
  let admissionOpen = false;

  const sweep = db.transaction((t: number) => {
    db.prepare(`DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(t);
    db.prepare(`DELETE FROM queue WHERE expires_at <= ?`).run(t);
    db.prepare(`DELETE FROM lists WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(t);
    db.prepare(`DELETE FROM locks WHERE expires_at <= ?`).run(t);
  });

  return {
    async connect() { /* opened in constructor */ },
    async disconnect() {
      if (admissionOpen) { db.exec("ROLLBACK"); admissionOpen = false; }
      db.close();
    },
    beginAdmission() {
      if (admissionOpen) throw new Error("mail admission transaction already open");
      db.exec("BEGIN IMMEDIATE");
      admissionOpen = true;
    },
    commitAdmission() {
      if (!admissionOpen) throw new Error("mail admission transaction is not open");
      db.exec("COMMIT");
      admissionOpen = false;
    },
    rollbackAdmission() {
      if (!admissionOpen) return;
      db.exec("ROLLBACK");
      admissionOpen = false;
    },

    // --- subscriptions ---
    async subscribe(threadId) {
      db.prepare(`INSERT OR IGNORE INTO subscriptions(thread_id) VALUES (?)`).run(threadId);
    },
    async unsubscribe(threadId) {
      db.prepare(`DELETE FROM subscriptions WHERE thread_id = ?`).run(threadId);
    },
    async isSubscribed(threadId) {
      return !!db.prepare(`SELECT 1 FROM subscriptions WHERE thread_id = ?`).get(threadId);
    },

    // --- locks (token + ttl; single-writer, so acquire is a plain upsert-if-free) ---
    async acquireLock(threadId, ttlMs) {
      const t = now(); sweep(t);
      const existing = db.prepare(`SELECT expires_at FROM locks WHERE thread_id = ?`).get(threadId) as
        | { expires_at: number }
        | undefined;
      if (existing && existing.expires_at > t) return null;
      const lock: Lock = { threadId, token: randomUUID(), expiresAt: t + ttlMs };
      db.prepare(
        `INSERT INTO locks(thread_id, token, expires_at) VALUES (@threadId, @token, @expiresAt)
         ON CONFLICT(thread_id) DO UPDATE SET token = @token, expires_at = @expiresAt`,
      ).run(lock);
      return lock;
    },
    async releaseLock(lock) {
      db.prepare(`DELETE FROM locks WHERE thread_id = ? AND token = ?`).run(lock.threadId, lock.token);
    },
    async extendLock(lock, ttlMs) {
      // Match the memory-adapter oracle: a token match on an already-expired
      // lock does NOT extend it (the holder lost the lock to expiry, even if
      // no other caller has raced in yet to acquire it).
      const t = now();
      const r = db
        .prepare(
          `UPDATE locks SET expires_at = ? WHERE thread_id = ? AND token = ? AND expires_at > ?`,
        )
        .run(t + ttlMs, lock.threadId, lock.token, t);
      return r.changes > 0;
    },
    async forceReleaseLock(threadId) {
      db.prepare(`DELETE FROM locks WHERE thread_id = ?`).run(threadId);
    },

    // --- queue (FIFO per thread, ttl per entry; trims oldest, keeps newest maxSize) ---
    async enqueue(threadId, entry, maxSize) {
      const t = now(); sweep(t);
      db.prepare(`INSERT INTO queue(thread_id, entry, expires_at) VALUES (?, ?, ?)`).run(
        threadId,
        JSON.stringify(entry),
        entry.expiresAt,
      );
      const depth = db.prepare(`SELECT COUNT(*) c FROM queue WHERE thread_id = ?`).get(threadId) as {
        c: number;
      };
      if (depth.c > maxSize) {
        db.prepare(
          `DELETE FROM queue WHERE id IN (
             SELECT id FROM queue WHERE thread_id = ? ORDER BY id ASC LIMIT ?)`,
        ).run(threadId, depth.c - maxSize);
      }
      return (db.prepare(`SELECT COUNT(*) c FROM queue WHERE thread_id = ?`).get(threadId) as {
        c: number;
      }).c;
    },
    async dequeue(threadId) {
      const t = now(); sweep(t);
      const row = db.prepare(`SELECT id, entry FROM queue WHERE thread_id = ? ORDER BY id ASC LIMIT 1`).get(
        threadId,
      ) as { id: number; entry: string } | undefined;
      if (!row) return null;
      db.prepare(`DELETE FROM queue WHERE id = ?`).run(row.id);
      return JSON.parse(row.entry) as QueueEntry;
    },
    async queueDepth(threadId) {
      sweep(now());
      return (db.prepare(`SELECT COUNT(*) c FROM queue WHERE thread_id = ?`).get(threadId) as { c: number })
        .c;
    },

    // --- lists (append-only; seq is a table-wide AUTOINCREMENT rowid, so no
    //     same-millisecond PK collision; maxLength trims oldest keeping newest,
    //     ttl refreshes the whole list's expiry on each append) ---
    async appendToList(key, value, options) {
      const t = now(); sweep(t);
      const exp = options?.ttlMs ? t + options.ttlMs : null;
      db.prepare(`INSERT INTO lists(key, value, expires_at) VALUES (?, ?, ?)`).run(
        key,
        JSON.stringify(value),
        exp,
      );
      // Every append redefines the whole list's expiry (matches the oracle:
      // absence of ttlMs clears it to never-expire, not "leave as-is").
      db.prepare(`UPDATE lists SET expires_at = ? WHERE key = ?`).run(exp, key);
      const max = options?.maxLength;
      if (max && max > 0) {
        const c = (db.prepare(`SELECT COUNT(*) c FROM lists WHERE key = ?`).get(key) as { c: number }).c;
        if (c > max) {
          db.prepare(
            `DELETE FROM lists WHERE seq IN (
               SELECT seq FROM lists WHERE key = ? ORDER BY seq ASC LIMIT ?)`,
          ).run(key, c - max);
        }
      }
    },
    async getList(key) {
      const t = now(); sweep(t);
      const rows = db
        .prepare(
          `SELECT value FROM lists WHERE key = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY seq ASC`,
        )
        .all(key, t) as { value: string }[];
      return rows.map((r) => JSON.parse(r.value));
    },

    // --- cache ---
    async get(key) {
      const t = now();
      const row = db.prepare(`SELECT value, expires_at FROM cache WHERE key = ?`).get(key) as
        | { value: string; expires_at: number | null }
        | undefined;
      if (!row) return null;
      if (row.expires_at !== null && row.expires_at <= t) {
        db.prepare(`DELETE FROM cache WHERE key = ?`).run(key);
        return null;
      }
      return JSON.parse(row.value);
    },
    async set(key, value, ttlMs) {
      const exp = ttlMs ? now() + ttlMs : null;
      db.prepare(
        `INSERT INTO cache(key, value, expires_at) VALUES (@k, @v, @e)
         ON CONFLICT(key) DO UPDATE SET value = @v, expires_at = @e`,
      ).run({ k: key, v: JSON.stringify(value), e: exp });
    },
    async setIfNotExists(key, value, ttlMs) {
      const t = now(); sweep(t);
      const exp = ttlMs ? t + ttlMs : null;
      const r = db
        .prepare(`INSERT OR IGNORE INTO cache(key, value, expires_at) VALUES (?, ?, ?)`)
        .run(key, JSON.stringify(value), exp);
      return r.changes > 0;
    },
    async delete(key) {
      db.prepare(`DELETE FROM cache WHERE key = ?`).run(key);
    },
  };
}
