// Integration tests for the local (OpenAI-compatible) RUNNER's agentic loop --
// spawns local-runner.mjs against a mock chat/completions server so the
// empty-turn nudge is exercised end-to-end (the adapter's pure parts are in
// local.test.mjs). The nudge: when the model ends a turn with no text AND no
// tool call (a give-up some models do after a tool error), the runner sends ONE
// follow-up nudge instead of accepting a silent empty "success".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_TURN_NUDGE, fitContext, CONTEXT_STUB, isContextFullError, trimStateToolOutputs } from "./runner-common.mjs";

const LOCAL_RUNNER = fileURLToPath(new URL("./local-runner.mjs", import.meta.url));

// Spawn the runner against a mock chat server that replies with `responses[n]`
// (an assistant message) for the n-th request. Returns the parsed JSONL events
// and the captured request bodies.
async function runLocalRunner(responses, { allowed = "", prompt = "do the task", expectReply = false, pathDir = null, contextMax = null } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const r = responses[requests.length - 1] ?? { role: "assistant", content: "" };
      // A response of {__status, __error} simulates an HTTP error (e.g. a 400
      // context-length overflow) so the runner's error/recovery paths are exercised.
      if (r && r.__status) {
        res.statusCode = r.__status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: { message: r.__error || "error" } }));
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: r }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const child = spawn(process.execPath, [LOCAL_RUNNER, "--allowed", allowed], {
    env: { ...process.env, OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, OPENAI_MODEL: "test", OPENAI_API_KEY: "x", BAXTER_EXPECT_REPLY: expectReply ? "1" : "", ...(contextMax != null ? { OPENAI_CONTEXT_MAX_TOKENS: String(contextMax) } : {}), ...(pathDir ? { PATH: `${pathDir}:${process.env.PATH}` } : {}) },
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin.end(prompt);
  let out = "";
  for await (const c of child.stdout) out += c;
  await new Promise((resolve) => child.on("close", resolve));
  server.close();
  const events = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { events, requests };
}

// --- context-full detection + saved-state trim (OpenRouter recovery) ---

test("isContextFullError matches context-overflow phrasings, not out-of-tokens/other", () => {
  for (const m of [
    "This model's maximum context length is 8192 tokens, however you requested 9000",
    "context_length_exceeded",
    "prompt is too long: 210000 tokens > 204800 maximum",
    "Please reduce the length of the messages",
    "input exceeds the context window",
  ]) assert.equal(isContextFullError(m), true, m);
  for (const m of ["429 rate limited", "insufficient credits", "connection refused", "no choices"]) {
    assert.equal(isContextFullError(m), false, m);
  }
  assert.equal(isContextFullError(new Error("context_length_exceeded")), true); // accepts an Error too
});

test("trimStateToolOutputs stubs oldest big tool outputs, keeps recent, ignores odd shapes", () => {
  const big = "x".repeat(1000);
  const state = { messages: [
    { type: "message", role: "user", content: "task" },
    { type: "function_call", callId: "a", arguments: "{}" },
    { type: "function_call_output", callId: "a", output: big },    // oldest big
    { type: "function_call_output", callId: "b", output: big },    // middle big
    { type: "function_call_output", callId: "c", output: big },    // recent big (kept)
    { type: "function_call_output", callId: "d", output: "tiny" }, // below stub size -> skipped
  ] };
  const n = trimStateToolOutputs(state, { keepRecent: 1 });
  assert.equal(n, 2);
  assert.equal(state.messages[2].output, CONTEXT_STUB);
  assert.equal(state.messages[3].output, CONTEXT_STUB);
  assert.equal(state.messages[4].output, big);    // most-recent big kept
  assert.equal(state.messages[5].output, "tiny"); // small untouched
  assert.equal(state.messages[2].callId, "a");    // id (pairing) preserved
});

test("trimStateToolOutputs is a guarded no-op on a string/absent/odd history", () => {
  assert.equal(trimStateToolOutputs({ messages: "just a string prompt" }), 0);
  assert.equal(trimStateToolOutputs(null), 0);
  assert.equal(trimStateToolOutputs({}), 0);
});

// --- context trim (fitContext) ---

test("fitContext stubs OLDEST tool results first, keeps system+prompt+recent, preserves pairing", () => {
  const big = "x".repeat(4000); // ~1000 tokens each (chars/4)
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "run_cli", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: big }, // oldest tool result
    { role: "assistant", content: null, tool_calls: [{ id: "b", type: "function", function: { name: "run_cli", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "b", content: big }, // most recent tool result
  ];
  const trimmed = fitContext(messages, 1200); // budget below two big results, above one
  assert.equal(trimmed, true);
  assert.equal(messages[0].content, "sys");         // system kept
  assert.equal(messages[1].content, "task");        // original prompt kept
  assert.equal(messages[3].content, CONTEXT_STUB);  // oldest tool result stubbed
  assert.equal(messages[3].tool_call_id, "a");      // pairing (id) preserved
  assert.equal(messages[5].content, big);           // recent tool result intact
});

test("fitContext also stubs oversized assistant tool_call arguments (e.g. a big write_file)", () => {
  const bigContent = "y".repeat(4000); // the payload lives in the ASSISTANT tool_call, not the result
  const messages = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: null, tool_calls: [{ id: "w", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "memory.md", content: bigContent }) } }] },
    { role: "tool", tool_call_id: "w", content: JSON.stringify({ ok: true, path: "memory.md" }) }, // tiny result
  ];
  const trimmed = fitContext(messages, 300); // well below the ~1000-token write_file argument
  assert.equal(trimmed, true);
  assert.ok(messages[2].tool_calls[0].function.arguments.length < 100, "big write_file argument stubbed");
  assert.equal(messages[2].tool_calls[0].id, "w", "tool_call id (pairing) preserved");
  assert.equal(messages[0].content, "s"); // system kept
  assert.equal(messages[1].content, "u"); // prompt kept
});

test("fitContext is a no-op under budget and when disabled (0)", () => {
  const mk = () => [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "tool", tool_call_id: "a", content: "x".repeat(400) },
  ];
  const under = mk();
  assert.equal(fitContext(under, 100000), false); // comfortably under budget
  assert.equal(under[2].content.length, 400);
  const disabled = mk();
  assert.equal(fitContext(disabled, 0), false); // 0 disables
  assert.equal(disabled[2].content.length, 400);
});

test("context-full mid-run -> trims the history and retries -> recovers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stub-cli-"));
  try {
    // A stub CLI that emits a big-ish output, so the history has something to trim.
    writeFileSync(join(dir, "bigcat"), "#!/bin/sh\nawk 'BEGIN{while(i++<5000)printf \"x\"}'\n");
    chmodSync(join(dir, "bigcat"), 0o755);
    const { events, requests } = await runLocalRunner(
      [
        { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "run_cli", arguments: JSON.stringify({ cli: "bigcat" }) } }] },
        { __status: 400, __error: "This model's maximum context length is 8192 tokens" }, // overflow on the next call
        { role: "assistant", content: "done" }, // succeeds after the trim-retry
      ],
      { allowed: "Bash(bigcat *)", pathDir: dir, contextMax: 0 }, // proactive budget OFF, so the retry path does the trimming
    );
    assert.equal(requests.length, 3, "toolcall -> context error -> trimmed retry");
    const result = events.find((e) => e.t === "result");
    assert.equal(result.subtype, "success");
    assert.equal(result.text, "done");
    const retriedWithStub = requests[2].messages.some((m) => m.role === "tool" && m.content === CONTEXT_STUB);
    assert.equal(retriedWithStub, true, "the big tool result was stubbed before the retry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context-full with nothing left to trim -> graceful stop (exit 0, not a hard fail)", async () => {
  const { events } = await runLocalRunner(
    [{ __status: 400, __error: "prompt is too long: exceeds the maximum context length" }], // overflow on the very first call
    { contextMax: 0 },
  );
  const result = events.find((e) => e.t === "result");
  assert.equal(result.subtype, "error");
  assert.equal(result.out_of_tokens, false);
  assert.match(result.text, /context full/); // graceful: a clear context-full result, not a raw crash
});

test("empty turn -> one nudge -> the model finishes (recovers the reply)", async () => {
  const { events, requests } = await runLocalRunner([
    { role: "assistant", content: null },       // degenerate empty turn: no text, no tool call
    { role: "assistant", content: "All set." }, // after the nudge
  ]);
  assert.equal(requests.length, 2, "one nudge -> exactly two model calls");
  const nudge = requests[1].messages.find((m) => m.role === "user" && m.content === EMPTY_TURN_NUDGE);
  assert.ok(nudge, "the follow-up request carries the nudge as a user message");
  const result = events.find((e) => e.t === "result");
  assert.equal(result.subtype, "success");
  assert.equal(result.text, "All set.", "final text recovered, not the empty give-up");
});

test("nudge fires at most once -> a still-empty turn is accepted without looping", async () => {
  const { events, requests } = await runLocalRunner([
    { role: "assistant", content: null }, // empty
    { role: "assistant", content: "" },   // STILL empty after the nudge
    { role: "assistant", content: "SHOULD-NOT-BE-REQUESTED" },
  ]);
  assert.equal(requests.length, 2, "nudge fires once; a still-empty turn ends the run (no 3rd call, no loop)");
  const result = events.find((e) => e.t === "result");
  assert.equal(result.subtype, "success");
  assert.equal(result.text, "", "empty accepted after a single nudge");
});

test("a normal non-empty final turn is NOT nudged", async () => {
  const { events, requests } = await runLocalRunner([{ role: "assistant", content: "done immediately" }]);
  assert.equal(requests.length, 1, "no nudge when the first turn already has text");
  assert.equal(events.find((e) => e.t === "result").text, "done immediately");
});

test("expect-reply: answered as text but never sent -> ONE poke to post it", async () => {
  const { requests } = await runLocalRunner(
    [
      { role: "assistant", content: "Here are the donation spots: Goodwill, Salvation Army…" }, // answer, no tool call
      { role: "assistant", content: "posted it." }, // after the poke
    ],
    { expectReply: true },
  );
  assert.equal(requests.length, 2, "answered-but-unsent gets one poke");
  const poke = requests[1].messages.find((m) => m.role === "user" && /never sent it/.test(m.content || ""));
  assert.ok(poke, "the follow-up carries the 'reformat into a tool call' poke, not the empty-turn nudge");
});

test("expect-reply: the unsent poke fires at most once (still-unsent is accepted)", async () => {
  const { requests } = await runLocalRunner(
    [
      { role: "assistant", content: "answer 1" },
      { role: "assistant", content: "answer 2, still no tool call" }, // ignored the poke
      { role: "assistant", content: "SHOULD-NOT-BE-REQUESTED" },
    ],
    { expectReply: true },
  );
  assert.equal(requests.length, 2, "one poke, then accept — no loop");
});

test("without expect-reply, a text answer is a real finish (no poke)", async () => {
  const { events, requests } = await runLocalRunner([{ role: "assistant", content: "Here's the answer." }], { expectReply: false });
  assert.equal(requests.length, 1, "reaction/heartbeat-style run isn't poked for not replying");
  assert.equal(events.find((e) => e.t === "result").text, "Here's the answer.");
});

test("an empty turn AFTER a delivered reply is NOT nudged (no duplicate send)", async () => {
  // Stub discord-cli on PATH so the reply tool call succeeds -> delivered=true.
  const dir = mkdtempSync(join(tmpdir(), "stub-cli-"));
  try {
    writeFileSync(join(dir, "discord-cli"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "discord-cli"), 0o755);
    const { requests } = await runLocalRunner(
      [
        { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "run_cli", arguments: JSON.stringify({ cli: "discord-cli", args: ["reply", "c", "m"], stdin: "hi" }) } }] },
        { role: "assistant", content: null }, // empty turn right after the delivered reply
      ],
      { expectReply: true, allowed: "Bash(discord-cli *)", pathDir: dir },
    );
    assert.equal(requests.length, 2, "delivered reply then empty turn -> real finish, no re-send nudge");
    const reNudged = requests.some((r) => (r.messages || []).some((m) => typeof m.content === "string" && m.content.includes(EMPTY_TURN_NUDGE)));
    assert.equal(reNudged, false, "EMPTY_TURN_NUDGE not sent after a reply was already delivered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
