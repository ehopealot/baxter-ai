import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadLetter } from "./dead-letter.ts";

test("deadLetter appends one JSON line per record, stamping surface + timestamp", () => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-"));
  process.env.DEAD_LETTER_DIR_OVERRIDE = dir;
  try {
    deadLetter("chat", { id: 5, error: "boom", intent: { id: 5, kind: "create-chat" } });
    deadLetter("chat", { id: 6, error: "boom2" });
    const lines = readFileSync(join(dir, "chat.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "appends, does not overwrite");
    const first = JSON.parse(lines[0]);
    assert.equal(first.surface, "chat");
    assert.equal(first.id, 5);
    assert.equal(first.error, "boom");
    assert.deepEqual(first.intent, { id: 5, kind: "create-chat" });
    assert.ok(typeof first.deadLetteredAt === "string" && first.deadLetteredAt.length > 0, "stamps a timestamp");
  } finally {
    delete process.env.DEAD_LETTER_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deadLetter is idempotent by agent work ID and source outcome ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-idempotent-"));
  process.env.DEAD_LETTER_DIR_OVERRIDE = dir;
  try {
    deadLetter("mail", { workId: "work-1", error: "first" });
    deadLetter("mail", { workId: "work-1", error: "replayed" });
    deadLetter("mail", { outcomeId: "source-2", error: "first source" });
    deadLetter("mail", { outcomeId: "source-2", error: "replayed source" });
    const rows = readFileSync(join(dir, "mail.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].error, "first", "the first immutable work outcome wins");
    assert.equal(rows[1].error, "first source", "the first immutable source outcome wins");
  } finally {
    delete process.env.DEAD_LETTER_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deadLetter keeps each surface in its own file", () => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-"));
  process.env.DEAD_LETTER_DIR_OVERRIDE = dir;
  try {
    deadLetter("chat", { id: 1 });
    deadLetter("sms", { id: 2 });
    assert.equal(readFileSync(join(dir, "chat.jsonl"), "utf8").trim().split("\n").length, 1);
    assert.equal(readFileSync(join(dir, "sms.jsonl"), "utf8").trim().split("\n").length, 1);
  } finally {
    delete process.env.DEAD_LETTER_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deadLetter THROWS if the append can't be written (so the caller won't ack past it)", () => {
  const base = mkdtempSync(join(tmpdir(), "dlq-"));
  const asFile = join(base, "afile");
  writeFileSync(asFile, "x");
  // A dead-letter dir whose parent is a regular file -> mkdirSync throws ENOTDIR.
  process.env.DEAD_LETTER_DIR_OVERRIDE = join(asFile, "nope");
  try {
    assert.throws(() => deadLetter("chat", { id: 1 }));
  } finally {
    delete process.env.DEAD_LETTER_DIR_OVERRIDE;
    rmSync(base, { recursive: true, force: true });
  }
});
