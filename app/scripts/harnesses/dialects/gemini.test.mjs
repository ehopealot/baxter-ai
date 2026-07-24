// Pure-function tests for the gemini generateContent dialect. Same axes as the
// anthropic tests, plus the Gemini-specific bits: role "model" not "assistant",
// tool calls matched by NAME (synthesized id), key in x-goog-api-key (never ?key=),
// and functionResponse wrapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, parseResponse, classifyError, defaultBaseUrl } from "./gemini.mjs";

const SPECS = [
  { name: "run_cli", description: "run a cli", params: [{ name: "cli", type: "string", required: true }, { name: "args", type: "string[]", required: false }] },
];

const TRANSCRIPT = [
  { role: "user", text: "do it" },
  { role: "assistant", text: "sure", toolCalls: [{ id: "run_cli#0", name: "run_cli", args: { cli: "web-cli", args: ["fetch", "u"] } }] },
  { role: "tool", results: [{ id: "run_cli#0", name: "run_cli", content: '{"ok":true}' }] },
];

test("gemini buildRequest: model in the path, key in x-goog-api-key header (never ?key=)", () => {
  const req = buildRequest({ baseUrl: "", model: "gemini-2.5-flash", apiKey: "AIza-secret", system: "SYS", transcript: TRANSCRIPT, specs: SPECS, maxOutputTokens: 2048 });
  assert.equal(req.url, `${defaultBaseUrl}/v1beta/models/gemini-2.5-flash:generateContent`);
  assert.equal(req.headers["x-goog-api-key"], "AIza-secret");
  assert.doesNotMatch(req.url, /AIza-secret/, "key must never appear in the URL");
  assert.doesNotMatch(req.url, /[?&]key=/, "must not use the ?key= query param");
  assert.deepEqual(req.body.systemInstruction, { parts: [{ text: "SYS" }] });
  assert.equal(req.body.generationConfig.maxOutputTokens, 2048);
});

test("gemini buildRequest: transcript renders to contents with role 'model' + functionCall/Response", () => {
  const { body } = buildRequest({ baseUrl: "", model: "m", apiKey: "k", system: "s", transcript: TRANSCRIPT, specs: SPECS, maxOutputTokens: 1 });
  assert.deepEqual(body.contents[0], { role: "user", parts: [{ text: "do it" }] });
  assert.equal(body.contents[1].role, "model");
  assert.deepEqual(body.contents[1].parts[0], { text: "sure" });
  assert.deepEqual(body.contents[1].parts[1], { functionCall: { name: "run_cli", args: { cli: "web-cli", args: ["fetch", "u"] } } });
  // tool bundle -> a user turn with functionResponse keyed by NAME (Gemini has no id)
  assert.deepEqual(body.contents[2], { role: "user", parts: [{ functionResponse: { name: "run_cli", response: { result: '{"ok":true}' } } }] });
});

test("gemini buildRequest: tools nest under functionDeclarations with parameters schema", () => {
  const { body } = buildRequest({ baseUrl: "", model: "m", apiKey: "k", system: "s", transcript: [{ role: "user", text: "hi" }], specs: SPECS, maxOutputTokens: 1 });
  assert.equal(body.tools[0].functionDeclarations[0].name, "run_cli");
  assert.equal(body.tools[0].functionDeclarations[0].parameters.type, "object");
  assert.deepEqual(body.tools[0].functionDeclarations[0].parameters.required, ["cli"]);
  assert.equal("toolConfig" in body, false, "no toolConfig by default (auto)");
  const noTools = buildRequest({ baseUrl: "", model: "m", apiKey: "k", system: "s", transcript: [{ role: "user", text: "hi" }], specs: [], maxOutputTokens: 1 });
  assert.equal("tools" in noTools.body, false);
});

test("gemini buildRequest: the wrap-up turn (toolChoice 'none') keeps declarations + sets toolConfig NONE", () => {
  const { body } = buildRequest({ baseUrl: "", model: "m", apiKey: "k", system: "s", transcript: TRANSCRIPT, specs: SPECS, maxOutputTokens: 1, toolChoice: "none" });
  assert.equal(body.tools[0].functionDeclarations.length, 1);
  assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: "NONE" } });
});

test("gemini buildRequest: two same-name calls in a turn round-trip to two ORDERED functionResponse parts", () => {
  // run_cli is effectively the only tool, so parallel calls are two calls both named
  // run_cli; Gemini matches responses positionally, so order (not a name-map) must hold.
  const t = [
    { role: "user", text: "go" },
    { role: "assistant", text: "", toolCalls: [
      { id: "run_cli#0", name: "run_cli", args: { cli: "discord-cli" } },
      { id: "run_cli#1", name: "run_cli", args: { cli: "web-cli" } },
    ] },
    { role: "tool", results: [
      { id: "run_cli#0", name: "run_cli", content: '{"first":true}' },
      { id: "run_cli#1", name: "run_cli", content: '{"second":true}' },
    ] },
  ];
  const { body } = buildRequest({ baseUrl: "", model: "m", apiKey: "k", system: "s", transcript: t, specs: SPECS, maxOutputTokens: 1 });
  const parts = body.contents[2].parts;
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].functionResponse.response, { result: '{"first":true}' });
  assert.deepEqual(parts[1].functionResponse.response, { result: '{"second":true}' });
});

test("gemini parseResponse: text + functionCall with synthesized id", () => {
  const r = parseResponse({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }, { functionCall: { name: "run_cli", args: { cli: "x" } } }] }, finishReason: "STOP" }] });
  assert.equal(r.text, "ok");
  assert.deepEqual(r.toolCalls, [{ id: "run_cli#0", name: "run_cli", args: { cli: "x" } }]);
  assert.equal(r.stopReason, "STOP");
});

test("gemini parseResponse: two calls get distinct synthesized ids", () => {
  const r = parseResponse({ candidates: [{ content: { parts: [{ functionCall: { name: "run_cli", args: {} } }, { functionCall: { name: "run_cli", args: {} } }] } }] });
  assert.deepEqual(r.toolCalls.map((c) => c.id), ["run_cli#0", "run_cli#1"]);
});

test("gemini parseResponse: degenerate response -> empty turn", () => {
  assert.deepEqual(parseResponse({}), { text: "", toolCalls: [], stopReason: null });
  assert.deepEqual(parseResponse({ candidates: [] }), { text: "", toolCalls: [], stopReason: null });
});

test("gemini classifyError: symbolic status + http code -> buckets", () => {
  assert.equal(classifyError({ status: 429, body: { error: { message: "quota", status: "RESOURCE_EXHAUSTED" } } }).kind, "out_of_tokens");
  assert.equal(classifyError({ status: 400, body: { error: { message: "x", status: "RESOURCE_EXHAUSTED" } } }).kind, "out_of_tokens", "symbolic status wins even without 429");
  assert.equal(classifyError({ status: 403, body: { error: { message: "no", status: "PERMISSION_DENIED" } } }).kind, "auth");
  assert.equal(classifyError({ status: 401, body: { error: { message: "no", status: "UNAUTHENTICATED" } } }).kind, "auth");
  // an invalid key is a 400 INVALID_ARGUMENT, not 401/403 -- still classified auth
  assert.equal(classifyError({ status: 400, body: { error: { message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } } }).kind, "auth");
  assert.equal(classifyError({ status: 400, body: { error: { message: "The input token count (1290000) exceeds the maximum number of tokens allowed (1048575)." } } }).kind, "context_full");
  assert.equal(classifyError({ status: 400, body: { error: { message: "bad arg" } } }).kind, "error");
  assert.equal(classifyError({ status: 500, body: "boom" }).message, "boom");
});
