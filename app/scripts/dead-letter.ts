// Dead-letter log for the SIDE-EFFECTFUL surfaces (chat, sms). When a drained
// intent/inbound fails non-retryably -- the store's own proper-lockfile retries are
// already exhausted, or a genuinely non-retryable error like a corrupt state file /
// ENOSPC / EIO -- the drain loop records it HERE and then advances its cursor + acks.
// Two properties this buys, both of which a plain catch-and-continue lacks:
//
//   1. The failed message is PRESERVED for inspection/replay instead of lost silently
//      (without this, a LATER successful intent's cumulative ack tells the DO to drop the
//      failed id from redelivery, and it's gone -- the exact loss the chat review flagged).
//   2. The cursor advances EXACTLY ONCE per intent, so the drain's redelivery gate
//      (`id <= cursor -> skip`) keeps a re-delivered intent from dispatching its run a
//      second time. This is why chat/sms use a DLQ rather than home's failedFloor: home's
//      checklist intents are pure + idempotent, so it can safely withhold-and-redeliver;
//      chat/sms DISPATCH A RUN (Baxter replies), so re-application would double-reply.
//      See home-mirror.ts's failedFloor for the pure-surface counterpart.
//
// One JSONL file per surface under DEAD_LETTER_DIR (append-only; the drain is serialized
// per surface, so a single writer, no lock needed). THROWS if the append itself fails: the
// caller MUST NOT ack/advance past an intent it could not durably record here, or it would
// be lost after all -- so a deadLetter() that throws propagates and the DO redelivers.
import { openSync, writeSync, fsyncSync, closeSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { DEAD_LETTER_DIR } from "./paths.ts";

function baseDir(): string {
  return process.env.DEAD_LETTER_DIR_OVERRIDE || DEAD_LETTER_DIR;
}

function fsyncDir(p: string): void {
  const dfd = openSync(p, "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

export function deadLetter(surface: string, record: Record<string, unknown>): void {
  const dir = baseDir();
  // mkdirSync's return value is the TOPMOST path it actually created (or undefined if
  // `dir` already existed) -- precise enough to drive the fsyncs below without a
  // TOCTOU-ish existsSync(dir) check racing the mkdirSync itself.
  const createdFrom = mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${surface}.jsonl`);
  const fileExisted = existsSync(filePath);
  const line = JSON.stringify({ surface, deadLetteredAt: new Date().toISOString(), ...record }) + "\n";
  // fsync, NOT a bare appendFileSync: the caller advances the cursor + acks (telling the DO
  // to PRUNE the intent) the instant this returns, so the line must survive a host power
  // loss in the writeback window -- otherwise the ack has dropped the id AND the only
  // durable record of it is gone, which is exactly the loss this queue exists to prevent.
  // The cursor/transcript writes don't fsync, but THIS is the last-resort record, so it
  // earns the flush. openSync throws on failure -> the caller doesn't ack past it.
  // A FILE fsync alone is durable for an APPEND into an already-existing file. But if
  // this call CREATES the file (the surface's first-ever dead letter) -- or creates the
  // dead-letter dir itself -- the new directory entry isn't persisted until the parent
  // directory is fsync'd too: a bare file fsync only flushes the file's own data/metadata,
  // not its parent's record that the file exists. Fsyncing a directory's OWN inode isn't
  // enough either -- POSIX crash-consistency doesn't persist an inode's entry in its
  // PARENT just because the inode itself was fsync'd. So on create (only -- not on the
  // common append path): fsync `dir` (covers the new file's entry in it), and if `dir`
  // itself was created, ALSO fsync the created dir's own parent (covers dir's entry in
  // IT) -- otherwise a power loss could still lose the whole freshly-created dead-letter
  // dir despite the file inside it being durable.
  const fd = openSync(filePath, "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!fileExisted || createdFrom !== undefined) {
    fsyncDir(dir);
    if (createdFrom !== undefined) {
      // If DEAD_LETTER_DIR_OVERRIDE points several nonexistent levels deep, this only
      // fsyncs the topmost created ancestor's parent, not every created ancestor along
      // the way -- a residual gap for that rare override. In production STATE_DIR always
      // pre-exists (every daemon writes state there at startup), so createdFrom is at
      // most `dir` and this one fsync closes the gap.
      fsyncDir(dirname(createdFrom));
    }
  }
}
