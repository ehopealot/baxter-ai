// Unit tests for the Claude Code harness adapter. Run with `node --test`
// (node:test is built in). Covers buildInvocation's flag layout, parseEvents'
// stream-json -> normalized-event decoding (including the multi-block and
// non-JSON cases the driver relies on), and detectOutcome's usage/rate-limit
// scanning with the success-gating that suppresses a false notice after a run
// that actually replied. Imports the real adapter, not a reimplementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeHarness } from "./claude.mjs";

const j = (obj) => JSON.stringify(obj);

test("buildInvocation lays out the claude -p stream-json flags with model + allowedTools", () => {
  const { command, args } = claudeHarness.buildInvocation({ model: "sonnet", allowedTools: "Read Write" });
  assert.equal(command, "claude");
  assert.deepEqual(args, [
    "-p",
    "--model",
    "sonnet",
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    "Read Write",
  ]);
});

test("parseEvents decodes an assistant tool_use block", () => {
  const line = j({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } });
  assert.deepEqual(claudeHarness.parseEvents(line), [{ kind: "tool_use", name: "Bash", input: { command: "ls" } }]);
});

test("parseEvents decodes a non-empty assistant text block and drops whitespace-only ones", () => {
  const withText = j({ type: "assistant", message: { content: [{ type: "text", text: "hello" }, { type: "text", text: "  \n" }] } });
  assert.deepEqual(claudeHarness.parseEvents(withText), [{ kind: "text", text: "hello" }]);
});

test("parseEvents returns multiple events for a line carrying several content blocks", () => {
  const line = j({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: { file: "a" } }, { type: "text", text: "done" }] },
  });
  assert.deepEqual(claudeHarness.parseEvents(line), [
    { kind: "tool_use", name: "Read", input: { file: "a" } },
    { kind: "text", text: "done" },
  ]);
});

test("parseEvents decodes a user tool_result block with its error status", () => {
  const ok = j({ type: "user", message: { content: [{ type: "tool_result", is_error: false, content: "out" }] } });
  assert.deepEqual(claudeHarness.parseEvents(ok), [{ kind: "tool_result", isError: false, content: "out" }]);
  const err = j({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] } });
  assert.deepEqual(claudeHarness.parseEvents(err), [{ kind: "tool_result", isError: true, content: "boom" }]);
});

test("parseEvents decodes a result event", () => {
  const line = j({ type: "result", subtype: "success", result: "all done" });
  assert.deepEqual(claudeHarness.parseEvents(line), [{ kind: "result", subtype: "success", text: "all done" }]);
});

test("parseEvents returns [] for non-JSON, unknown, and shapeless lines (never throws)", () => {
  assert.deepEqual(claudeHarness.parseEvents("claude: some non-JSON failure line"), []);
  assert.deepEqual(claudeHarness.parseEvents(j({ type: "system", subtype: "init" })), []);
  assert.deepEqual(claudeHarness.parseEvents(j({ type: "assistant" })), []); // no message/content
});

test("detectOutcome: healthy run that replied is not flagged", () => {
  const lines = [
    j({ type: "system", subtype: "init", model: "claude-sonnet-5" }),
    j({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1_700_000_000 } }),
    j({ type: "result", is_error: false, result: "Done." }),
  ];
  assert.deepEqual(claudeHarness.detectOutcome(lines), { outOfTokens: false, resetsAt: 1_700_000_000 });
});

test("detectOutcome: allowed_warning is still a healthy status", () => {
  const lines = [
    j({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 42 } }),
    j({ type: "result", is_error: false, result: "ok" }),
  ];
  assert.equal(claudeHarness.detectOutcome(lines).outOfTokens, false);
});

test("detectOutcome: blocking rate_limit status on a failed run flags out-of-tokens with reset time", () => {
  const lines = [
    j({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_700_000_999 } }),
    j({ type: "result", is_error: true, result: "stopped" }),
  ];
  assert.deepEqual(claudeHarness.detectOutcome(lines), { outOfTokens: true, resetsAt: 1_700_000_999 });
});

test("detectOutcome: bare 429 terminal result flags out-of-tokens", () => {
  const lines = [j({ type: "result", is_error: true, api_error_status: 429, result: "" })];
  assert.equal(claudeHarness.detectOutcome(lines).outOfTokens, true);
});

test("detectOutcome: usage-limit text in a failed result flags out-of-tokens", () => {
  const lines = [j({ type: "result", is_error: true, result: "Claude AI usage limit reached" })];
  assert.equal(claudeHarness.detectOutcome(lines).outOfTokens, true);
});

test("detectOutcome: success suppresses a stray blocking status (no false notice after a real reply)", () => {
  const lines = [
    j({ type: "rate_limit_event", rate_limit_info: { status: "some_new_status", resetsAt: 5 } }),
    j({ type: "assistant", message: { content: [{ type: "text", text: "replied" }] } }),
    j({ type: "result", is_error: false, result: "sent the reply" }),
  ];
  assert.equal(claudeHarness.detectOutcome(lines).outOfTokens, false);
});

test("detectOutcome: non-JSON lines are skipped without throwing", () => {
  const lines = ["claude: some non-JSON failure line", "", j({ type: "result", is_error: true, api_error_status: 429 })];
  assert.equal(claudeHarness.detectOutcome(lines).outOfTokens, true);
});

test("detectOutcome: no rate-limit and no result leaves both fields at defaults", () => {
  const lines = [j({ type: "system", subtype: "init" })];
  assert.deepEqual(claudeHarness.detectOutcome(lines), { outOfTokens: false, resetsAt: null });
});

test("describe returns the driver model, defaulting to sonnet", () => {
  assert.equal(claudeHarness.describe("haiku"), "haiku");
  assert.equal(claudeHarness.describe(undefined), "sonnet");
  assert.equal(claudeHarness.describe(""), "sonnet");
});
