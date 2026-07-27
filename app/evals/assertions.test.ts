// @ts-nocheck -- TS migration bridge (2026-07-27); this file is not yet typed. Remove this line and drive `tsc --noEmit` green for it in its cluster task. See docs/superpowers/plans/2026-07-27-typescript-migration.md
// Unit tests for the eval assertion library -- the PURE core (no LLM, no runAgent).
// It operates on the normalized event stream runAgent's onEvent emits:
//   { kind:"tool_use", name, input } | { kind:"result", subtype, text } | { kind:"text", text }
// Run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captureFromEvents, calledTool, notCalledTool, toolCallCount,
  succeeded, delivered, replyMatches, replyOmits, custom, runAssertions,
} from "./assertions.ts";

const tool = (name, input) => ({ kind: "tool_use", name, input });
const runCli = (cli, args, stdin) => tool("run_cli", { cli, args, stdin });
const result = (subtype, text = "") => ({ kind: "result", subtype, text });

// A representative trace: reads memory, hits data-cli, replies once, finishes.
const TRACE = [
  tool("read_file", { path: "/w/memory.md" }),
  runCli("data-cli", ["espn", "scoreboard"], undefined),
  runCli("discord-cli", ["reply", "chan1", "msg1"], "The 49ers won 24-17."),
  { kind: "text", text: "Done." },
  result("success", "posted the score"),
];

test("captureFromEvents pulls toolUses, result, and delivery replies (stdin of a delivery call)", () => {
  const cap = captureFromEvents(TRACE);
  assert.equal(cap.toolUses.length, 3); // read_file, data-cli, discord-cli reply
  assert.deepEqual(cap.result, { subtype: "success", text: "posted the score" });
  assert.deepEqual(cap.replies, ["The 49ers won 24-17."]); // only the delivery call's stdin
});

test("calledTool matches a run_cli by cli(+sub) AND a native tool by name", () => {
  const cap = captureFromEvents(TRACE);
  assert.equal(calledTool("data-cli")(cap).pass, true);
  assert.equal(calledTool("discord-cli", "reply")(cap).pass, true);
  assert.equal(calledTool("read_file")(cap).pass, true); // native tool by name
  assert.equal(calledTool("discord-cli", "send")(cap).pass, false); // wrong sub
  assert.equal(calledTool("web-cli")(cap).pass, false); // never called
});

test("notCalledTool is the inverse (used for boundary checks like no schedule-cli)", () => {
  const cap = captureFromEvents(TRACE);
  assert.equal(notCalledTool("schedule-cli")(cap).pass, true);   // good: absent
  assert.equal(notCalledTool("data-cli")(cap).pass, false);      // present -> fails
});

test("toolCallCount compares the tool_use count", () => {
  const cap = captureFromEvents(TRACE); // 3 tool calls
  assert.equal(toolCallCount("<=", 6)(cap).pass, true);
  assert.equal(toolCallCount("<=", 2)(cap).pass, false);
  assert.equal(toolCallCount("==", 3)(cap).pass, true);
  assert.equal(toolCallCount(">=", 3)(cap).pass, true);
});

test("succeeded checks the final result subtype", () => {
  assert.equal(succeeded()(captureFromEvents(TRACE)).pass, true);
  assert.equal(succeeded()(captureFromEvents([result("error", "context full")])).pass, false);
  assert.equal(succeeded()(captureFromEvents([])).pass, false); // no result at all
});

test("delivered is true iff a reply/send actually went out", () => {
  assert.equal(delivered()(captureFromEvents(TRACE)).pass, true);
  // a run that only 'presents' the answer as text but never sends it -> not delivered
  const noSend = [tool("read_file", { path: "/w/m" }), result("success", "here's the answer")];
  assert.equal(delivered()(captureFromEvents(noSend)).pass, false);
});

test("replyMatches/replyOmits inspect the delivered text, not the final message", () => {
  const cap = captureFromEvents(TRACE);
  assert.equal(replyMatches(/49ers/)(cap).pass, true);
  assert.equal(replyMatches(/Chiefs/)(cap).pass, false);
  assert.equal(replyOmits(/Chiefs/)(cap).pass, true);
  assert.equal(replyOmits(/49ers/)(cap).pass, false); // present -> omit fails
});

test("custom wraps an arbitrary predicate (boolean or {pass,why})", () => {
  const cap = captureFromEvents(TRACE);
  assert.equal(custom((c) => c.toolUses.length === 3, "exactly 3 tools")(cap).pass, true);
  assert.deepEqual(custom((c) => ({ pass: false, why: "nope" }))(cap), { pass: false, why: "nope" });
});

test("runAssertions folds a list into an overall pass + per-assertion reasons", () => {
  const cap = captureFromEvents(TRACE);
  const ok = runAssertions(cap, [delivered(), calledTool("data-cli"), notCalledTool("schedule-cli")]);
  assert.equal(ok.pass, true);
  assert.equal(ok.checks.length, 3);
  const bad = runAssertions(cap, [delivered(), calledTool("web-cli")]);
  assert.equal(bad.pass, false); // one failed
  assert.ok(bad.checks.some((c) => !c.pass));
});
