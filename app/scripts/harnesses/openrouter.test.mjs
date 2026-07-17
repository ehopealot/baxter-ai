// Unit tests for the OpenRouter harness adapter's pure parts (no SDK/API needed):
// buildInvocation, the JSONL event decoding, and outcome detection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openrouterHarness } from "./openrouter.mjs";

test("buildInvocation spawns the runner with node + the allowedTools string on --allowed", () => {
  const { command, args } = openrouterHarness.buildInvocation({ model: "sonnet", allowedTools: "Bash(discord-cli *) Read" });
  assert.equal(command, process.execPath); // node
  assert.match(args[0], /openrouter-runner\.mjs$/);
  assert.deepEqual(args.slice(1), ["--allowed", "Bash(discord-cli *) Read"]);
});

test("buildInvocation tolerates a missing allowedTools", () => {
  const { args } = openrouterHarness.buildInvocation({});
  assert.deepEqual(args.slice(1), ["--allowed", ""]);
});

const j = (o) => JSON.stringify(o);

test("parseEvents maps each runner event kind and skips junk", () => {
  assert.deepEqual(openrouterHarness.parseEvents(j({ t: "tool_use", name: "run_cli", input: { cli: "discord-cli" } })), [
    { kind: "tool_use", name: "run_cli", input: { cli: "discord-cli" } },
  ]);
  assert.deepEqual(openrouterHarness.parseEvents(j({ t: "tool_result", is_error: true, content: { ok: false } })), [
    { kind: "tool_result", isError: true, content: { ok: false } },
  ]);
  assert.deepEqual(openrouterHarness.parseEvents(j({ t: "text", text: "hi" })), [{ kind: "text", text: "hi" }]);
  assert.deepEqual(openrouterHarness.parseEvents(j({ t: "text", text: "   " })), []); // whitespace-only dropped
  assert.deepEqual(openrouterHarness.parseEvents(j({ t: "result", subtype: "success", text: "done" })), [
    { kind: "result", subtype: "success", text: "done" },
  ]);
  assert.deepEqual(openrouterHarness.parseEvents("not json"), []);
  assert.deepEqual(openrouterHarness.parseEvents(j({ t: "unknown" })), []);
});

test("detectOutcome flags out-of-tokens only when the runner set it, and reads resets_at", () => {
  const success = [j({ t: "text", text: "ok" }), j({ t: "result", subtype: "success", text: "ok", out_of_tokens: false, resets_at: null })];
  assert.deepEqual(openrouterHarness.detectOutcome(success), { outOfTokens: false, resetsAt: null });

  const broke = [j({ t: "result", subtype: "error", text: "402 insufficient credits", out_of_tokens: true, resets_at: 1_700_000_000 })];
  assert.deepEqual(openrouterHarness.detectOutcome(broke), { outOfTokens: true, resetsAt: 1_700_000_000 });

  assert.deepEqual(openrouterHarness.detectOutcome(["junk", j({ t: "tool_use", name: "x" })]), { outOfTokens: false, resetsAt: null });
});
