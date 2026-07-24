// Unit tests for the shared runner pieces: the tool-spec set derived from a run's
// grants, and the JSON-Schema rendering the local (chat/completions) runner uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolSpecs, toJsonSchema, systemPreamble, isDeliveryCall, shouldEscalateModel, fitTranscript, CONTEXT_STUB } from "./runner-common.mjs";
import { parseAllowedTools } from "./openrouter-tools.mjs";

test("toolSpecs yields run_cli plus the granted native tools", () => {
  const { cliMap, native } = parseAllowedTools("Bash(discord-cli *) Bash(web-cli *) Read Write Skill");
  const specs = toolSpecs(cliMap, native);
  assert.deepEqual(specs.map((s) => s.name).sort(), ["load_skill", "read_file", "run_cli", "write_file"]);
  const runCli = specs.find((s) => s.name === "run_cli");
  assert.match(runCli.description, /discord-cli, web-cli/); // available CLIs listed
});

test("toolSpecs omits run_cli when no CLI is granted, and only builds granted native tools", () => {
  const { cliMap, native } = parseAllowedTools("Read Edit");
  assert.deepEqual(toolSpecs(cliMap, native).map((s) => s.name).sort(), ["edit_file", "read_file"]);
});

test("toJsonSchema renders params to OpenAI-style JSON Schema", () => {
  const spec = {
    params: [
      { name: "cli", type: "string", required: true, description: "the cli" },
      { name: "args", type: "string[]", required: false },
      { name: "stdin", type: "string", required: false },
    ],
  };
  const js = toJsonSchema(spec);
  assert.equal(js.type, "object");
  assert.deepEqual(js.properties.cli, { type: "string", description: "the cli" });
  assert.deepEqual(js.properties.args, { type: "array", items: { type: "string" } });
  assert.deepEqual(js.properties.stdin, { type: "string" });
  assert.deepEqual(js.required, ["cli"]); // only required params
});

test("systemPreamble lists the run's CLIs and bridges WebSearch/WebFetch to web-cli", () => {
  const { cliMap } = parseAllowedTools("Bash(discord-cli *) Bash(web-cli *)");
  const p = systemPreamble(cliMap);
  assert.match(p, /Available CLIs: discord-cli, web-cli/);
  assert.match(p, /web-cli.*search/s);
  // "act, don't narrate": sending a reply is a tool call, not final-message text
  // (guards against the qwen3.6-flash narrate-instead-of-act give-up).
  assert.match(p, /never just text in your final message/);
  assert.match(p, /leaves the task UNDONE/);
});

test("systemPreamble injects the current date/time (these harnesses have no other clock)", () => {
  const p = systemPreamble({});
  // A real, current ISO-UTC timestamp is present, labelled as "now".
  assert.match(p, /current date and time is .*\d{4}-\d{2}-\d{2}T[\d:.]+Z.*UTC/);
  assert.ok(p.includes(String(new Date().getUTCFullYear())));
  assert.match(p, /do NOT rely on training data for the current date/);
});

test("isDeliveryCall recognizes reply/send tool calls, not reactions/reads", () => {
  const d = (cli, ...args) => isDeliveryCall("run_cli", { cli, args });
  assert.equal(d("discord-cli", "reply", "chan", "msg"), true);
  assert.equal(d("discord-cli", "send", "chan"), true);
  assert.equal(d("discord-cli", "send-thread", "chan"), true);
  assert.equal(d("discord-cli", "react", "chan", "msg", "👀"), false);
  assert.equal(d("mail", "reply", "id"), true);
  assert.equal(d("mail", "send", "subject"), true);
  assert.equal(d("code-cli", "python"), false);
  assert.equal(isDeliveryCall("read_file", { path: "x" }), false); // not run_cli
  assert.equal(isDeliveryCall("run_cli", undefined), false); // defensive
});

test("shouldEscalateModel escalates once on a generic/over-long failure, not on out-of-tokens", () => {
  const base = { model: "minimax/minimax-m2.7", fallbackModel: "minimax/minimax-m3", alreadyEscalated: false };
  // The exact bug: minimax's over-long "invalid_prompt"/"invalid request" -> escalate.
  assert.equal(shouldEscalateModel({ ...base, err: 'Response failed: {"code":"invalid_prompt","message":"invalid request error"}' }), true);
  // A recognized context-full that survived trimming also escalates (bigger window helps).
  assert.equal(shouldEscalateModel({ ...base, err: "context_length_exceeded: too many tokens" }), true);
  // Regression (2026-07-20 dropped reply): minimax's DETAILED over-long message, which
  // reaches shouldEscalateModel from the nudge/poke path when its extra turn overflows
  // the window. Must escalate (no 402/429, no out-of-tokens keyword) so the bigger model
  // delivers the owed reply instead of dropping it.
  assert.equal(shouldEscalateModel({ ...base, err: 'Response failed: {"code":"invalid_prompt","message":"This model\'s maximum context length is 196608 tokens. However, your messages resulted in 202585 tokens. Please reduce the length of the messages."}' }), true);
  // Any other opaque failure escalates too -- broad by design, no fragile wording match.
  assert.equal(shouldEscalateModel({ ...base, err: "socket hang up" }), true);

  // Out-of-tokens (credit/rate) must NOT escalate -- a pricier model fails the same.
  assert.equal(shouldEscalateModel({ ...base, err: "429 rate limit exceeded" }), false);
  assert.equal(shouldEscalateModel({ ...base, err: "402 insufficient credits" }), false);
  assert.equal(shouldEscalateModel({ ...base, err: "quota exceeded" }), false);
});

test("shouldEscalateModel trusts a definitive HTTP status over opaque message wording", () => {
  const base = { model: "minimax/minimax-m2.7", fallbackModel: "minimax/minimax-m3", alreadyEscalated: false };
  // A rate-limit / out-of-credit error whose BODY is opaque (NO OUT_OF_TOKENS_RE
  // keyword) must still be caught by its status -- else it burns the one escalation
  // on a pricier model. Bodies here deliberately avoid "rate limit"/"quota"/"429"
  // etc. so only the status check can return false.
  assert.equal(shouldEscalateModel({ ...base, err: { status: 429, message: "<html>please slow down</html>" } }), false);
  assert.equal(shouldEscalateModel({ ...base, err: { status: 402, message: "" } }), false);
  // Sanity: strip the status and that same opaque 429 body WOULD escalate -- proving
  // the assertions above pass on the status path, not incidental message wording.
  assert.equal(shouldEscalateModel({ ...base, err: { message: "<html>please slow down</html>" } }), true);
  // A 400-class error object (the invalid_prompt shape) still escalates.
  assert.equal(shouldEscalateModel({ ...base, err: { status: 400, message: "invalid request error" } }), true);
});

// --- fitTranscript: the normalized-transcript context trimmer (custom harness) ---

const big = (n) => "x".repeat(n);

test("fitTranscript: no-op under budget or with a 0 budget", () => {
  const t = [{ role: "user", text: "hi" }, { role: "assistant", text: "yo", toolCalls: [] }];
  assert.equal(fitTranscript(t, 100000), false);
  assert.equal(fitTranscript(t, 0), false, "0 budget disables trimming");
});

test("fitTranscript: pass 1 stubs oldest tool-result contents first, preserving ids", () => {
  const t = [
    { role: "user", text: "prompt" },
    { role: "assistant", text: "", toolCalls: [{ id: "a1", name: "run_cli", args: { cli: "web-cli" } }] },
    { role: "tool", results: [{ id: "a1", name: "run_cli", content: big(4000) }] },
    { role: "assistant", text: "", toolCalls: [{ id: "a2", name: "run_cli", args: { cli: "web-cli" } }] },
    { role: "tool", results: [{ id: "a2", name: "run_cli", content: big(4000) }] },
  ];
  assert.equal(fitTranscript(t, 500), true);
  // oldest tool result stubbed; its id is intact
  assert.equal(t[2].results[0].content, CONTEXT_STUB);
  assert.equal(t[2].results[0].id, "a1");
  // item 0 (the prompt) is never touched
  assert.equal(t[0].text, "prompt");
});

test("fitTranscript: pass 2 stubs oversized tool-call ARGS when results alone don't fit", () => {
  const t = [
    { role: "user", text: "prompt" },
    // a giant write_file-style payload lives in the ARGS, not a tool result
    { role: "assistant", text: "", toolCalls: [{ id: "w1", name: "write_file", args: { path: "big.txt", content: big(8000) } }] },
    { role: "tool", results: [{ id: "w1", name: "write_file", content: '{"ok":true}' }] },
  ];
  assert.equal(fitTranscript(t, 300), true);
  assert.deepEqual(t[1].toolCalls[0].args, { elided: CONTEXT_STUB });
  assert.equal(t[1].toolCalls[0].id, "w1", "tool-call id preserved through arg stubbing");
});

test("fitTranscript: never drops an item and keeps the original prompt (item 0)", () => {
  const t = [
    { role: "user", text: big(2000) }, // the prompt itself is large but must-keep
    { role: "assistant", text: "", toolCalls: [{ id: "a1", name: "run_cli", args: {} }] },
    { role: "tool", results: [{ id: "a1", name: "run_cli", content: big(4000) }] },
  ];
  const len = t.length;
  fitTranscript(t, 100);
  assert.equal(t.length, len, "no item dropped");
  assert.equal(t[0].text, big(2000), "the prompt is never stubbed even when over budget");
});

test("shouldEscalateModel guards: once per run, needs a distinct fallback", () => {
  const err = "invalid request error";
  // No fallback configured -> disabled (today's behavior).
  assert.equal(shouldEscalateModel({ err, model: "m2.7", fallbackModel: "", alreadyEscalated: false }), false);
  // Already escalated -> don't loop.
  assert.equal(shouldEscalateModel({ err, model: "m2.7", fallbackModel: "m3", alreadyEscalated: true }), false);
  // Already on the fallback (e.g. a multimodal run started on m3) -> no self-escalation.
  assert.equal(shouldEscalateModel({ err, model: "minimax/minimax-m3", fallbackModel: "minimax/minimax-m3", alreadyEscalated: false }), false);
});
