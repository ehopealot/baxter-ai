// Pure-function tests for the anthropic Messages dialect: buildRequest wire shape
// (incl. the key landing in the header and NOT the URL), parseResponse extraction,
// and classifyError bucket mapping. No network -- the dialect does no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, parseResponse, classifyError, defaultBaseUrl } from "./anthropic.mjs";

const SPECS = [
  {
    name: "run_cli",
    description: "run a cli",
    params: [
      { name: "cli", type: "string", required: true, description: "which cli" },
      { name: "args", type: "string[]", required: false },
    ],
  },
];

// A mixed transcript exercising every item shape + strict user/assistant alternation.
const TRANSCRIPT = [
  { role: "user", text: "do the task" },
  { role: "assistant", text: "on it", toolCalls: [{ id: "tu_1", name: "run_cli", args: { cli: "discord-cli", args: ["send", "1", "hi"] } }, { id: "tu_2", name: "run_cli", args: { cli: "web-cli", args: ["fetch", "x"] } }] },
  { role: "tool", results: [{ id: "tu_1", name: "run_cli", content: '{"ok":true}' }, { id: "tu_2", name: "run_cli", content: '{"ok":false}' }] },
  { role: "user", text: "nudge" },
];

test("anthropic buildRequest: endpoint, version header, and key in x-api-key (never the URL)", () => {
  const req = buildRequest({ baseUrl: "", model: "claude-x", apiKey: "sk-secret", system: "SYS", transcript: TRANSCRIPT, specs: SPECS, maxOutputTokens: 4096 });
  assert.equal(req.url, `${defaultBaseUrl}/v1/messages`);
  assert.equal(req.headers["x-api-key"], "sk-secret");
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  assert.doesNotMatch(req.url, /sk-secret/, "key must not be in the URL");
  assert.equal(req.body.model, "claude-x");
  assert.equal(req.body.max_tokens, 4096);
  assert.equal(req.body.system, "SYS");
});

test("anthropic buildRequest: base URL override wins and trailing slash is trimmed", () => {
  const req = buildRequest({ baseUrl: "https://proxy.internal/", model: "m", apiKey: "k", system: "s", transcript: [{ role: "user", text: "hi" }], specs: [], maxOutputTokens: 1 });
  assert.equal(req.url, "https://proxy.internal/v1/messages");
});

test("anthropic buildRequest: transcript renders to alternating content-block messages", () => {
  const { body } = buildRequest({ baseUrl: "", model: "m", apiKey: "k", system: "s", transcript: TRANSCRIPT, specs: SPECS, maxOutputTokens: 1 });
  assert.deepEqual(body.messages[0], { role: "user", content: [{ type: "text", text: "do the task" }] });
  assert.equal(body.messages[1].role, "assistant");
  assert.deepEqual(body.messages[1].content[0], { type: "text", text: "on it" });
  assert.deepEqual(body.messages[1].content[1], { type: "tool_use", id: "tu_1", name: "run_cli", input: { cli: "discord-cli", args: ["send", "1", "hi"] } });
  assert.equal(body.messages[2].role, "user");
  assert.deepEqual(body.messages[2].content[0], { type: "tool_result", tool_use_id: "tu_1", content: '{"ok":true}' });
  assert.deepEqual(body.messages[3], { role: "user", content: [{ type: "text", text: "nudge" }] });
  // strict alternation user/assistant/user/user? No -- tool bundle is a user turn,
  // so the sequence is user, assistant, user, user only if a nudge follows a tool
  // bundle; here it's user, assistant, user(tool), user(nudge) which the runner never
  // actually produces (a nudge only follows an assistant turn). Assert the shapes, not
  // an alternation the fixture doesn't model.
  assert.equal(body.messages.length, 4);
});

test("anthropic buildRequest: tools render with input_schema (JSON Schema); omitted only when NO tools granted", () => {
  const { body } = buildRequest({ baseUrl: "", model: "m", apiKey: "k", system: "s", transcript: [{ role: "user", text: "hi" }], specs: SPECS, maxOutputTokens: 1 });
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].name, "run_cli");
  assert.equal(body.tools[0].input_schema.type, "object");
  assert.deepEqual(body.tools[0].input_schema.required, ["cli"]);
  assert.equal(body.tools[0].input_schema.properties.args.type, "array");
  assert.equal("tool_choice" in body, false, "no tool_choice by default (auto)");
  // A run with no CLIs/native tools granted -> no tools field at all.
  const noTools = buildRequest({ baseUrl: "", model: "m", apiKey: "k", system: "s", transcript: [{ role: "user", text: "hi" }], specs: [], maxOutputTokens: 1 });
  assert.equal("tools" in noTools.body, false);
});

test("anthropic buildRequest: the wrap-up turn (toolChoice 'none') KEEPS tools + adds tool_choice none", () => {
  // The bug this guards: dropping tools on the wrap-up 400s the Messages API when the
  // transcript already carries tool_use/tool_result blocks (the step-cap case always does).
  const { body } = buildRequest({ baseUrl: "", model: "m", apiKey: "k", system: "s", transcript: TRANSCRIPT, specs: SPECS, maxOutputTokens: 1, toolChoice: "none" });
  assert.equal(body.tools.length, 1, "tools MUST still be sent on the wrap-up");
  assert.deepEqual(body.tool_choice, { type: "none" });
});

test("anthropic buildRequest: a text-less assistant turn still carries a block (empty text)", () => {
  const { body } = buildRequest({ baseUrl: "", model: "m", apiKey: "k", system: "s", transcript: [{ role: "user", text: "hi" }, { role: "assistant", text: "", toolCalls: [] }], specs: [], maxOutputTokens: 1 });
  assert.deepEqual(body.messages[1], { role: "assistant", content: [{ type: "text", text: "" }] });
});

test("anthropic parseResponse: text only", () => {
  const r = parseResponse({ content: [{ type: "text", text: "hello" }], stop_reason: "end_turn" });
  assert.deepEqual(r, { text: "hello", toolCalls: [], stopReason: "end_turn" });
});

test("anthropic parseResponse: mixed text + tool_use, ids preserved", () => {
  const r = parseResponse({ content: [{ type: "text", text: "ok " }, { type: "tool_use", id: "tu_9", name: "run_cli", input: { cli: "x" } }], stop_reason: "tool_use" });
  assert.equal(r.text, "ok ");
  assert.deepEqual(r.toolCalls, [{ id: "tu_9", name: "run_cli", args: { cli: "x" } }]);
  assert.equal(r.stopReason, "tool_use");
});

test("anthropic parseResponse: degenerate/empty content -> empty turn", () => {
  assert.deepEqual(parseResponse({}), { text: "", toolCalls: [], stopReason: null });
  assert.deepEqual(parseResponse({ content: [] }), { text: "", toolCalls: [], stopReason: null });
  // a tool_use with missing input defaults to {}
  assert.deepEqual(parseResponse({ content: [{ type: "tool_use", id: "t", name: "n" }] }).toolCalls, [{ id: "t", name: "n", args: {} }]);
});

test("anthropic classifyError: status + phrasing -> buckets", () => {
  assert.equal(classifyError({ status: 401, body: { error: { message: "bad key" } } }).kind, "auth");
  assert.equal(classifyError({ status: 403, body: {} }).kind, "auth");
  assert.equal(classifyError({ status: 429, body: { error: { message: "rate limited" } } }).kind, "out_of_tokens");
  assert.equal(classifyError({ status: 529, body: { error: { message: "overloaded" } } }).kind, "out_of_tokens");
  const ctx = classifyError({ status: 400, body: { error: { message: "prompt is too long: 250000 tokens > 200000 maximum" } } });
  assert.equal(ctx.kind, "context_full");
  assert.match(ctx.message, /prompt is too long/);
  assert.equal(classifyError({ status: 400, body: { error: { message: "bad request" } } }).kind, "error");
  // message falls back to a string body, then to the status
  assert.equal(classifyError({ status: 500, body: "upstream boom" }).message, "upstream boom");
  assert.equal(classifyError({ status: 500, body: {} }).message, "HTTP 500");
});
