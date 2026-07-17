// Unit tests for the local (OpenAI-compatible) harness adapter. Its parseEvents /
// detectOutcome are the shared runner-events functions, covered by
// openrouter.test.mjs; here we just pin buildInvocation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { localHarness } from "./local.mjs";
import { parseRunnerEvents, detectRunnerOutcome } from "./runner-events.mjs";

test("localHarness.buildInvocation spawns local-runner.mjs with the allowedTools string", () => {
  const { command, args } = localHarness.buildInvocation({ allowedTools: "Bash(discord-cli *) Read" });
  assert.equal(command, process.execPath); // node
  assert.match(args[0], /local-runner\.mjs$/);
  assert.deepEqual(args.slice(1), ["--allowed", "Bash(discord-cli *) Read"]);
});

test("localHarness reuses the shared event decoder (same wire protocol as openrouter)", () => {
  assert.equal(localHarness.parseEvents, parseRunnerEvents);
  assert.equal(localHarness.detectOutcome, detectRunnerOutcome);
});
