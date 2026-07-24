// Integration tests for the custom-API RUNNER's agentic loop -- spawns
// custom-runner.mjs (dialect=anthropic) against a mock Messages server, so the
// transcript loop, nudges, delivery short-circuit, wrap-up, and error classification
// are exercised end-to-end. The dialects' pure parts are in dialects/*.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNER = fileURLToPath(new URL("./custom-runner.mjs", import.meta.url));

// Anthropic response-body builders.
const text = (t, stop = "end_turn") => ({ content: [{ type: "text", text: t }], stop_reason: stop });
const toolUse = (id, cli, args, msg = "") => ({
  content: [...(msg ? [{ type: "text", text: msg }] : []), { type: "tool_use", id, name: "run_cli", input: { cli, args } }],
  stop_reason: "tool_use",
});
const empty = () => ({ content: [], stop_reason: "end_turn" });

// Gemini generateContent response-body builders (for the gemini-dialect runs below).
const gText = (t) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] }, finishReason: "STOP" }] });
const gToolUse = (cli, args) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "run_cli", args: { cli, args } } }] }, finishReason: "STOP" }] });

// A temp dir with fake CLIs on PATH (each prints {"ok":true}, exits 0), so a
// run_cli call actually spawns something.
function mkClis(names) {
  const dir = mkdtempSync(join(tmpdir(), "customcli-"));
  for (const n of names) {
    const p = join(dir, n);
    writeFileSync(p, `#!/bin/sh\necho '{"ok":true}'\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}

// Spawn the runner against a mock Messages server that replies with responses[n]
// for the n-th request. A response of {__status,__error} simulates an HTTP error.
async function runRunner(responses, { dialect = "anthropic", allowed = "", prompt = "do the task", expectReply = false, replyRequired = false, pathDir = null, maxSteps = null, contextMax = null } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const r = responses[requests.length - 1] ?? text("");
      if (r && r.__status) {
        res.statusCode = r.__status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: { message: r.__error || "error", type: r.__type || "error" } }));
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(r));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const child = spawn(process.execPath, [RUNNER, "--allowed", allowed], {
    env: {
      ...process.env,
      CUSTOM_API_DIALECT: dialect,
      CUSTOM_API_MODEL: "test",
      CUSTOM_API_KEY: "sk-test",
      CUSTOM_API_BASE_URL: `http://127.0.0.1:${port}`,
      BAXTER_EXPECT_REPLY: expectReply ? "1" : "",
      BAXTER_REPLY_REQUIRED: replyRequired ? "1" : "",
      ...(maxSteps != null ? { CUSTOM_API_MAX_STEPS: String(maxSteps) } : {}),
      ...(contextMax != null ? { CUSTOM_API_CONTEXT_MAX_TOKENS: String(contextMax) } : {}),
      ...(pathDir ? { PATH: `${pathDir}:${process.env.PATH}` } : {}),
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin.end(prompt);
  let out = "";
  for await (const c of child.stdout) out += c;
  const code = await new Promise((resolve) => child.on("close", resolve));
  server.close();
  const events = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { events, requests, code };
}

test("custom-runner: fails hard on an unknown dialect", async () => {
  // No mock server needed -- it fails before any request.
  const child = spawn(process.execPath, [RUNNER, "--allowed", ""], {
    env: { ...process.env, CUSTOM_API_DIALECT: "bogus", CUSTOM_API_MODEL: "m", CUSTOM_API_KEY: "k" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin.end("hi");
  let out = "";
  for await (const c of child.stdout) out += c;
  const code = await new Promise((r) => child.on("close", r));
  const events = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(code, 1);
  assert.match(events.at(-1).text, /Unknown CUSTOM_API_DIALECT/);
});

test("custom-runner: tool call then final text -> tool_use, tool_result, text, success", async () => {
  const dir = mkClis(["web-cli"]);
  try {
    const { events, requests, code } = await runRunner([toolUse("tu1", "web-cli", ["fetch", "x"], "looking"), text("all done")], { allowed: "Bash(web-cli *)", pathDir: dir });
    assert.equal(code, 0);
    const kinds = events.map((e) => e.t);
    assert.ok(kinds.includes("tool_use") && kinds.includes("tool_result"));
    const result = events.at(-1);
    assert.equal(result.t, "result");
    assert.equal(result.subtype, "success");
    assert.equal(result.text, "all done");
    // second request carried the tool_result back to the model (transcript threading)
    assert.equal(requests.length, 2);
    const lastMsg = requests[1].messages.at(-1);
    assert.equal(lastMsg.role, "user");
    assert.equal(lastMsg.content[0].type, "tool_result");
    assert.equal(lastMsg.content[0].tool_use_id, "tu1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("custom-runner: an empty turn is nudged, then finishes", async () => {
  // expectReply:false isolates the EMPTY nudge (the empty branch has no expectReply
  // gate); with expectReply the text turn would additionally trigger the unsent poke.
  const { events, requests } = await runRunner([empty(), text("finally")]);
  assert.equal(requests.length, 2, "the empty turn triggered a second (nudged) request");
  // the nudge was appended as a user turn
  const secondReqLastUser = requests[1].messages.at(-1);
  assert.equal(secondReqLastUser.role, "user");
  assert.match(secondReqLastUser.content[0].text, /no message and no tool call|Do not stop/);
  assert.ok(events.some((e) => e.t === "note" && /nudging/.test(e.text)));
  assert.equal(events.at(-1).subtype, "success");
});

test("custom-runner: delivered then a request failure is treated as done (no duplicate, exit 0)", async () => {
  const dir = mkClis(["discord-cli"]);
  try {
    const { events, code, requests } = await runRunner(
      [toolUse("tu1", "discord-cli", ["reply", "chan", "msg"]), { __status: 500, __error: "upstream boom" }],
      { allowed: "Bash(discord-cli *)", pathDir: dir, expectReply: true },
    );
    assert.equal(code, 0, "a post-delivery failure must not hard-fail (heartbeat would re-fire)");
    assert.equal(requests.length, 2);
    const result = events.at(-1);
    assert.equal(result.subtype, "success");
    assert.ok(events.some((e) => e.t === "note" && /already delivered/.test(e.text)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("custom-runner: 429 -> out_of_tokens result, exit 0", async () => {
  const { events, code } = await runRunner([{ __status: 429, __error: "rate limited" }]);
  assert.equal(code, 0, "out-of-tokens is a graceful 'couldn't get to this', not a hard failure");
  const result = events.at(-1);
  assert.equal(result.subtype, "error");
  assert.equal(result.out_of_tokens, true);
});

test("custom-runner: auth 401 -> hard fail (exit 1), not out_of_tokens", async () => {
  const { events, code } = await runRunner([{ __status: 401, __error: "invalid x-api-key" }]);
  assert.equal(code, 1);
  const result = events.at(-1);
  assert.equal(result.subtype, "error");
  assert.equal(result.out_of_tokens, false);
});

test("custom-runner: a context-full 400 ends gracefully (exit 0) as a context-full stop", async () => {
  const { events, code } = await runRunner([{ __status: 400, __error: "prompt is too long: 300000 tokens > 200000 maximum" }]);
  assert.equal(code, 0, "context-full won't fix on retry -> graceful stop, not a hard failure");
  const result = events.at(-1);
  assert.equal(result.subtype, "error");
  assert.equal(result.out_of_tokens, false);
  assert.match(result.text, /context full/);
});

test("custom-runner (gemini): a wrap-up context-overflow the DIALECT recognizes ends gracefully, not a stale success", async () => {
  // Regression for the wrap-up-catch bug: Gemini's overflow phrasing isn't in the shared
  // CONTEXT_FULL_RE (only the dialect's classifyError -> kind:"context_full" catches it),
  // so a wrap-up catch that checked only kind:"out_of_tokens"/isContextFullError swallowed
  // it into subtype:"success" with stale text. maxSteps=1 -> the step makes a tool call
  // (doesn't finish) -> the wrap-up request overflows.
  const dir = mkClis(["web-cli"]);
  try {
    const { events, code } = await runRunner(
      [gToolUse("web-cli", ["fetch", "x"]), { __status: 400, __error: "The input token count (1290000) exceeds the maximum number of tokens allowed (1048575)." }],
      { dialect: "gemini", allowed: "Bash(web-cli *)", pathDir: dir, maxSteps: 1 },
    );
    assert.equal(code, 0, "context-full is a graceful stop, not a hard fail");
    const result = events.at(-1);
    assert.equal(result.subtype, "error", "must NOT be swallowed into a success");
    assert.equal(result.out_of_tokens, false);
    assert.match(result.text, /context full/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("custom-runner (gemini): a normal tool-call-then-text run works end-to-end", async () => {
  const dir = mkClis(["web-cli"]);
  try {
    const { events, requests, code } = await runRunner([gToolUse("web-cli", ["fetch", "x"]), gText("gemini done")], { dialect: "gemini", allowed: "Bash(web-cli *)", pathDir: dir });
    assert.equal(code, 0);
    assert.equal(events.at(-1).text, "gemini done");
    // the tool result was threaded back as a functionResponse (gemini wire shape)
    assert.equal(requests.length, 2);
    assert.equal(requests[1].contents.at(-1).parts[0].functionResponse.name, "run_cli");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("custom-runner: hitting the step cap forces a no-tools wrap-up final turn", async () => {
  const dir = mkClis(["web-cli"]);
  try {
    // maxSteps=1: the single step makes a tool call (doesn't finish), so the wrap-up
    // turn runs with NO tools and its text becomes the final answer.
    const { events, requests, code } = await runRunner(
      [toolUse("tu1", "web-cli", ["fetch", "x"]), text("wrapped up")],
      { allowed: "Bash(web-cli *)", pathDir: dir, maxSteps: 1 },
    );
    assert.equal(code, 0);
    assert.equal(requests.length, 2);
    // The wrap-up KEEPS tools (the transcript has tool blocks -> Anthropic 400s without
    // them) and suppresses use via tool_choice:none, rather than omitting tools.
    assert.ok(Array.isArray(requests[1].tools) && requests[1].tools.length, "wrap-up still sends tools");
    assert.deepEqual(requests[1].tool_choice, { type: "none" });
    assert.equal(events.at(-1).text, "wrapped up");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
