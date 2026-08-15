// T2 (usage-metrics): runAgent records one kind:"tool" signal per tool_result
// at the emit() choke point -- the tool NAME paired from the preceding tool_use
// via a per-run FIFO (tool_result events carry no name on any harness wire),
// surface from RunAgentOptions, still recorded under logEvents:false (the TUI
// path). The fake harness spawns `node -e <script>` printing runner-protocol
// lines and reuses the REAL runner decoder (harnesses/runner-events.ts), so
// these tests exercise the same decoded-event loop production uses. Static
// import + USAGE_DIR_OVERRIDE set per test before each runAgent call (the
// signal store reads the override at call time, not module-evaluation time --
// same convention as runtime-usage.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./runtime.ts";
import type { Harness, Surface } from "./runtime.ts";
import { parseRunnerEvents, detectRunnerOutcome } from "./harnesses/runner-events.ts";

const RUNS = mkdtempSync(join(tmpdir(), "runsig-runs-"));
const dirs: string[] = []; // every per-test usage/cwd dir, removed in test.after

// A fake harness whose "runner" is `node -e <script>` printing one runner-
// protocol JSONL line per console.log. parseEvents/detectOutcome are the real
// shared runner decoder, so emit()'s decoded-event loop sees exactly what an
// openrouter/local/custom run would produce.
function scriptHarness(script: string): Harness {
  return {
    name: "script",
    describe: () => "script",
    buildInvocation: () => ({ command: process.execPath, args: ["-e", script] }),
    parseEvents: parseRunnerEvents,
    detectOutcome: detectRunnerOutcome,
  };
}

// Run the script harness through runAgent with a FRESH usage override dir, then
// return the parsed signals.jsonl lines ([] when none were recorded).
async function runScript(script: string, surface: Surface, opts: { logEvents?: boolean } = {}): Promise<Record<string, unknown>[]> {
  const dir = mkdtempSync(join(tmpdir(), "runsig-"));
  dirs.push(dir);
  process.env.USAGE_DIR_OVERRIDE = dir;
  await runAgent({
    prompt: "hi",
    logId: `sig-${dirs.length}`,
    cwd: dir,
    runsDir: RUNS,
    surface,
    harness: scriptHarness(script),
    logEvents: opts.logEvents,
  });
  try {
    return readFileSync(join(dir, "signals.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return []; // no signals.jsonl -> nothing was recorded
  }
}

// The PRIMARY case: two tool_use events then two tool_results (ok, then
// is_error). Only a true FIFO queue can attribute A/ok then B/error -- a
// last-name-reuse implementation would emit B twice.
const SEQ = `
for (const e of [
  { t: "tool_use", name: "alpha", input: {} },
  { t: "tool_use", name: "beta", input: {} },
  { t: "tool_result", content: "fine" },
  { t: "tool_result", is_error: true, content: "boom" },
]) console.log(JSON.stringify(e));
`;

test("FIFO sequence: exactly one tool signal per tool_result, A/ok then B/error, in persisted order", async () => {
  const sig = await runScript(SEQ, "mail");
  assert.equal(sig.length, 2);
  assert.equal(sig[0].kind, "tool");
  assert.equal(sig[0].surface, "mail");
  assert.equal(sig[0].tool, "alpha");
  assert.equal(sig[0].ok, true);
  assert.equal(sig[0].v, 1);
  assert.equal(typeof sig[0].t, "number");
  assert.equal(sig[1].kind, "tool");
  assert.equal(sig[1].surface, "mail");
  assert.equal(sig[1].tool, "beta");
  assert.equal(sig[1].ok, false);
  assert.equal(sig[1].v, 1);
});

test("metering is in emit, not logEvent: logEvents=false (TUI) still records", async () => {
  const sig = await runScript(
    `console.log(JSON.stringify({ t: "tool_use", name: "bash" }));
     console.log(JSON.stringify({ t: "tool_result", is_error: true, content: "x" }));`,
    "tui",
    { logEvents: false },
  );
  assert.equal(sig.length, 1);
  assert.equal(sig[0].surface, "tui");
  assert.equal(sig[0].tool, "bash");
  assert.equal(sig[0].ok, false); // is_error:true -> ok:false
});

test("a tool_result with no prior tool_use records tool \"(unknown)\"", async () => {
  const sig = await runScript(
    `console.log(JSON.stringify({ t: "tool_result", content: "orphan" }));`,
    "discord",
  );
  assert.equal(sig.length, 1);
  assert.equal(sig[0].surface, "discord");
  assert.equal(sig[0].tool, "(unknown)");
  assert.equal(sig[0].ok, true);
});

test.after(() => {
  rmSync(RUNS, { recursive: true, force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
