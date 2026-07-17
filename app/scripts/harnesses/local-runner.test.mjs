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
import { EMPTY_TURN_NUDGE } from "./runner-common.mjs";

const LOCAL_RUNNER = fileURLToPath(new URL("./local-runner.mjs", import.meta.url));

// Spawn the runner against a mock chat server that replies with `responses[n]`
// (an assistant message) for the n-th request. Returns the parsed JSONL events
// and the captured request bodies.
async function runLocalRunner(responses, { allowed = "", prompt = "do the task" } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const message = responses[requests.length - 1] ?? { role: "assistant", content: "" };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const child = spawn(process.execPath, [LOCAL_RUNNER, "--allowed", allowed], {
    env: { ...process.env, OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, OPENAI_MODEL: "test", OPENAI_API_KEY: "x" },
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
