// core/app/scripts/chat-cli.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sendReply } from "./chat-cli.ts";
import { createChat, readMessages } from "./chat-transcript.ts";

const CLI = fileURLToPath(new URL("./chat-cli.ts", import.meta.url));

function harness(): string {
  const dir = mkdtempSync(join(tmpdir(), "chat-cli-"));
  process.env.CHATS_DIR_OVERRIDE = dir;
  return dir;
}
function cleanup(dir: string): void {
  delete process.env.CHATS_DIR_OVERRIDE;
  rmSync(dir, { recursive: true, force: true });
}

test("sendReply appends a baxter message with the given content to the transcript", async () => {
  const dir = harness();
  try {
    createChat("wc-1", "2026-08-05T00:00:00Z");
    await sendReply("wc-1", "hello there");
    const m = readMessages("wc-1");
    assert.equal(m.at(-1)?.authorId, "baxter");
    assert.equal(m.at(-1)?.content, "hello there");
    assert.equal(m.at(-1)?.authorName, process.env.PERSONA_NAME || "Baxter");
    assert.ok(m.at(-1)?.id, "message id must be minted");
  } finally { cleanup(dir); }
});

test("sendReply mints a unique id per call", async () => {
  const dir = harness();
  try {
    createChat("wc-1", "2026-08-05T00:00:00Z");
    await sendReply("wc-1", "one");
    await sendReply("wc-1", "two");
    const m = readMessages("wc-1");
    assert.notEqual(m[0].id, m[1].id);
  } finally { cleanup(dir); }
});

// Regression tripwire: appendMessage's "no index entry" invariant (Task 1.1)
// must surface as a rejection here, not be swallowed -- a chat-cli caller
// that never called createChat should get a nonzero exit, not a silent
// orphan messages.jsonl.
test("sendReply rejects when the chat id has no index entry", async () => {
  const dir = harness();
  try {
    await assert.rejects(() => sendReply("wc-99", "hi"), /no index entry/);
  } finally { cleanup(dir); }
});

// Regression tripwire: an empty/whitespace-only body must be refused loudly,
// not appended as a silent-success empty bubble -- chat has no provider (like
// Sendblue's own empty-body rejection for SMS) to catch this, so chat-cli
// must refuse it itself.
test("sendReply rejects an empty or whitespace-only body", async () => {
  const dir = harness();
  try {
    createChat("wc-1", "2026-08-05T00:00:00Z");
    await assert.rejects(() => sendReply("wc-1", ""), /empty message body/);
    await assert.rejects(() => sendReply("wc-1", "   \n"), /empty message body/);
    assert.equal(readMessages("wc-1").length, 0, "no message should have been appended");
  } finally { cleanup(dir); }
});

// ---- CLI subprocess: the unknown/missing-subcommand contract ----
// A run_cli CLI that exits 0 on misuse reads as success and makes the model
// loop (2026-08-05 SMS-incident invariant) -- so both "no subcommand at all"
// and "an unrecognized one" must exit nonzero.

test("missing subcommand exits nonzero", () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(r.status, 1);
});

test("unknown subcommand exits nonzero", () => {
  const r = spawnSync(process.execPath, [CLI, "bogus"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command/);
});

// End-to-end: the CLI's main guard actually reads stdin and appends via the
// real chat-transcript store (not just the exported sendReply fn above).
test("chat-cli send <chatId> reads stdin and appends the message end-to-end", () => {
  const dir = harness();
  try {
    createChat("wc-2", "2026-08-05T00:00:00Z");
    const r = spawnSync(process.execPath, [CLI, "send", "wc-2"], {
      encoding: "utf8",
      input: "hi from stdin",
      env: { ...process.env, CHATS_DIR_OVERRIDE: dir },
    });
    assert.equal(r.status, 0, r.stderr);
    const m = readMessages("wc-2");
    assert.equal(m.at(-1)?.authorId, "baxter");
    assert.equal(m.at(-1)?.content, "hi from stdin");
  } finally { cleanup(dir); }
});

test("chat-cli send <chatId> with empty stdin exits nonzero (no silent-success empty bubble)", () => {
  const dir = harness();
  try {
    createChat("wc-3", "2026-08-05T00:00:00Z");
    const r = spawnSync(process.execPath, [CLI, "send", "wc-3"], {
      encoding: "utf8",
      input: "",
      env: { ...process.env, CHATS_DIR_OVERRIDE: dir },
    });
    assert.equal(r.status, 1);
    assert.equal(readMessages("wc-3").length, 0);
  } finally { cleanup(dir); }
});

test("chat-cli send <unknownChatId> exits nonzero (appendMessage's throw surfaces)", () => {
  const dir = harness();
  try {
    const r = spawnSync(process.execPath, [CLI, "send", "wc-does-not-exist"], {
      encoding: "utf8",
      input: "hi",
      env: { ...process.env, CHATS_DIR_OVERRIDE: dir },
    });
    assert.equal(r.status, 1);
  } finally { cleanup(dir); }
});
