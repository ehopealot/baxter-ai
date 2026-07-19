import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrainDecision, decide, DISPATCH_TOOL, isSpeakableAnswer } from "./voice-brain.mjs";

test("isSpeakableAnswer drops placeholder non-answers, keeps real speech", () => {
  // real short answers must survive -- including ones that superficially look like non-answers
  for (const yes of ["Doing well, thanks!", "The capital of France is Paris.", "No, that's not right", "Nothing beats a good coffee", "No thanks", "None.", "Nothing."]) {
    assert.equal(isSpeakableAnswer(yes), true, yes);
  }
  for (const no of ["", "   ", "no response", "No response.", "No response…", "No response...", "No response..", "No response….", "No response!!", "(no response)", "No comment", "nothing to add", "(silence)", "silent", "n/a", "N/A", "...", "…", "--", "no reply needed…"]) {
    assert.equal(isSpeakableAnswer(no), false, JSON.stringify(no));
  }
});

test("parseBrainDecision: plain content -> speak", () => {
  const d = parseBrainDecision({ content: "It's about 3pm in Tokyo." });
  assert.deepEqual(d, { action: "speak", text: "It's about 3pm in Tokyo." });
});

test("parseBrainDecision: dispatch_to_baxter tool call -> dispatch (task + spoken ack)", () => {
  const d = parseBrainDecision({
    content: "yeah, on it",
    tool_calls: [{ function: { name: "dispatch_to_baxter", arguments: JSON.stringify({ task: "check the weather in Boston and report back" }) } }],
  });
  assert.deepEqual(d, { action: "dispatch", task: "check the weather in Boston and report back", ack: "yeah, on it" });
});

test("parseBrainDecision: malformed tool arguments -> dispatch with empty task (caller decides)", () => {
  const d = parseBrainDecision({ content: "on it", tool_calls: [{ function: { name: "dispatch_to_baxter", arguments: "{not json" } }] });
  assert.equal(d.action, "dispatch");
  assert.equal(d.task, "");
});

test("parseBrainDecision: a different tool name is ignored -> speak", () => {
  const d = parseBrainDecision({ content: "hi", tool_calls: [{ function: { name: "some_other_tool", arguments: "{}" } }] });
  assert.deepEqual(d, { action: "speak", text: "hi" });
});

test("parseBrainDecision: missing content -> empty strings, never throws", () => {
  assert.deepEqual(parseBrainDecision({}), { action: "speak", text: "" });
  assert.deepEqual(parseBrainDecision(null), { action: "speak", text: "" });
});

// A fake fetch returning a chat/completions body.
function fakeFetch({ ok = true, status = 200, message = {}, bodyText = "" } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => ({ choices: [{ message }] }),
    text: async () => bodyText,
  });
}

test("decide sends the tool + system prompt, a timeout signal, and returns a speak decision", async () => {
  let sentBody;
  let sentSignal;
  const fetchFn = async (url, opts) => { sentBody = JSON.parse(opts.body); sentSignal = opts.signal; return { ok: true, json: async () => ({ choices: [{ message: { content: "Sure, it's Tuesday." } }] }) }; };
  const d = await decide("what day is it", { model: "minimax/minimax-m2.7", apiKey: "k", fetchFn });
  assert.deepEqual(d, { action: "speak", text: "Sure, it's Tuesday." });
  assert.equal(sentBody.tools[0].function.name, "dispatch_to_baxter");
  assert.equal(sentBody.messages[0].role, "system");
  assert.equal(sentBody.messages.at(-1).content, "what day is it");
  assert.ok(sentSignal instanceof AbortSignal, "fetch gets an AbortSignal (timeout guard)");
});

test("decide injects shared memory into the system prompt when provided, omits it otherwise", async () => {
  let sys;
  const fetchFn = async (u, opts) => { sys = JSON.parse(opts.body).messages[0].content; return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) }; };
  await decide("who am i", { model: "m", apiKey: "k", memory: "Erik is the operator; likes concise replies.", fetchFn });
  assert.match(sys, /What Baxter already knows/); // the injected memory-block header
  assert.match(sys, /Erik is the operator/); // the memory content
  await decide("hi", { model: "m", apiKey: "k", fetchFn });
  assert.doesNotMatch(sys, /What Baxter already knows/); // no memory BLOCK when none supplied
  assert.doesNotMatch(sys, /Erik is the operator/);
});

test("decide returns a dispatch decision on a tool call", async () => {
  const d = await decide("book me a table", {
    model: "m", apiKey: "k",
    fetchFn: fakeFetch({ message: { content: "on it", tool_calls: [{ function: { name: "dispatch_to_baxter", arguments: JSON.stringify({ task: "book a table" }) } }] } }),
  });
  assert.equal(d.action, "dispatch");
  assert.equal(d.task, "book a table");
});

test("decide throws on a non-ok HTTP response", async () => {
  await assert.rejects(() => decide("hi", { model: "m", apiKey: "k", fetchFn: fakeFetch({ ok: false, status: 429, bodyText: "rate limited" }) }), /brain HTTP 429/);
});

test("decide throws without an api key or model", async () => {
  await assert.rejects(() => decide("hi", { model: "m", apiKey: "", fetchFn: fakeFetch() }), /OPENROUTER_API_KEY/);
  await assert.rejects(() => decide("hi", { model: "", apiKey: "k", fetchFn: fakeFetch() }), /model is not set/);
});

test("DISPATCH_TOOL shape is a valid function tool with a required task", () => {
  assert.equal(DISPATCH_TOOL.type, "function");
  assert.deepEqual(DISPATCH_TOOL.function.parameters.required, ["task"]);
});
