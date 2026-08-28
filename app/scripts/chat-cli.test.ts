// core/app/scripts/chat-cli.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { replayChatOutputs, sendReply } from "./chat-cli.ts";
import { prepareOutput, type ChatOutputOperation } from "./surface-output-receipts.ts";
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
    await createChat("wc-1", "2026-08-05T00:00:00Z");
    await sendReply("wc-1", "hello there");
    const m = readMessages("wc-1");
    assert.equal(m.at(-1)?.authorId, "baxter");
    assert.equal(m.at(-1)?.content, "hello there");
    assert.equal(m.at(-1)?.authorName, process.env.PERSONA_NAME || "Baxter");
    assert.ok(m.at(-1)?.id, "message id must be minted");
  } finally { cleanup(dir); }
});

test("durable work output is idempotent and reconciles before terminal success", async () => {
  const dir = harness();
  process.env.CHAT_OUTPUT_RECEIPTS_DIR_OVERRIDE = join(dir, "receipts");
  try {
    await createChat("wc-1", "2026-08-05T00:00:00Z");
    const env = { BAXTER_WORK_ID: "a".repeat(64) };
    const first = await sendReply("wc-1", "durable hello", env);
    const second = await sendReply("wc-1", "durable hello", env);
    assert.equal(second.id, first.id);
    assert.equal(readMessages("wc-1").length, 1);
  } finally { delete process.env.CHAT_OUTPUT_RECEIPTS_DIR_OVERRIDE; cleanup(dir); }
});

test("prepared chat output crash replay appends and completes without model involvement", async () => {
  const dir = harness();
  process.env.CHAT_OUTPUT_RECEIPTS_DIR_OVERRIDE = join(dir, "receipts");
  try {
    await createChat("wc-1", "2026-08-05T00:00:00Z");
    const workId = "d".repeat(64);
    const operation: ChatOutputOperation = { kind: "chat", chatId: "wc-1", content: "prepared", authorName: "Baxter" };
    await prepareOutput("chat", workId, operation);
    const receipts = await replayChatOutputs(workId);
    assert.equal(receipts.length, 1);
    assert.deepEqual(readMessages("wc-1").map(message => message.content), ["prepared"]);
    await replayChatOutputs(workId);
    assert.equal(readMessages("wc-1").length, 1);
  } finally { delete process.env.CHAT_OUTPUT_RECEIPTS_DIR_OVERRIDE; cleanup(dir); }
});

test("sendReply mints a unique id per call", async () => {
  const dir = harness();
  try {
    await createChat("wc-1", "2026-08-05T00:00:00Z");
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
    await createChat("wc-1", "2026-08-05T00:00:00Z");
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
test("chat-cli send <chatId> reads stdin and appends the message end-to-end", async () => {
  const dir = harness();
  try {
    await createChat("wc-2", "2026-08-05T00:00:00Z");
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

test("chat-cli send <chatId> with empty stdin exits nonzero (no silent-success empty bubble)", async () => {
  const dir = harness();
  try {
    await createChat("wc-3", "2026-08-05T00:00:00Z");
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

test("chat-cli skip exits successfully without appending a transcript entry", async () => {
  const dir = harness();
  try {
    await createChat("wc-4", "2026-08-05T00:00:00Z");
    const before = readMessages("wc-4");
    const r = spawnSync(process.execPath, [CLI, "skip"], {
      encoding: "utf8",
      input: "",
      env: { ...process.env, CHATS_DIR_OVERRIDE: dir },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { skipped: true });
    assert.deepEqual(readMessages("wc-4"), before);
  } finally { cleanup(dir); }
});

test("chat-cli skip reports a positional reason", () => {
  const dir = harness();
  try {
    const r = spawnSync(process.execPath, [CLI, "skip", "nothing actionable"], {
      encoding: "utf8",
      input: "",
      env: { ...process.env, CHATS_DIR_OVERRIDE: dir },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { skipped: true });
    assert.match(r.stderr, /reason=nothing actionable/);
  } finally { cleanup(dir); }
});

test("chat-cli skip joins multiple positional reason words", () => {
  const dir = harness();
  try {
    const r = spawnSync(process.execPath, [CLI, "skip", "nothing", "actionable"], {
      encoding: "utf8",
      input: "",
      env: { ...process.env, CHATS_DIR_OVERRIDE: dir },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { skipped: true });
    assert.match(r.stderr, /reason=nothing actionable/);
  } finally { cleanup(dir); }
});
