// Unit tests for the custom-API harness adapter's buildInvocation. The runner's
// agentic loop is covered end-to-end by custom-runner.test.ts; here we pin the
// --allowed flag layout, especially the EMPTY allowedTools string -- the
// zero-tool representation a tool-less generation (the daily calendar digest)
// passes: parseAllowedTools("") grants no CLIs and no native tools, and the
// flag must never be dropped (the runner would then read no allowlist at all).
import { test } from "node:test";
import assert from "node:assert/strict";
import { customHarness } from "./custom.ts";

test("customHarness.buildInvocation spawns custom-runner.ts with the allowedTools string", () => {
  const { command, args } = customHarness.buildInvocation({ allowedTools: "Bash(discord-cli *) Read" });
  assert.equal(command, process.execPath); // node
  assert.match(args[0], /custom-runner\.ts$/);
  assert.deepEqual(args.slice(1), ["--allowed", "Bash(discord-cli *) Read"]);
});

test("customHarness.buildInvocation keeps --allowed with the empty string (never drops the flag)", () => {
  const { command, args } = customHarness.buildInvocation({ allowedTools: "" });
  assert.equal(command, process.execPath); // node
  assert.match(args[0], /custom-runner\.ts$/);
  assert.deepEqual(args.slice(1), ["--allowed", ""]);
});
