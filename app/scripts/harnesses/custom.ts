// @ts-nocheck -- TS migration bridge (2026-07-27); this file is not yet typed. Remove this line and drive `tsc --noEmit` green for it in its cluster task. See docs/superpowers/plans/2026-07-27-typescript-migration.md
// Custom-API harness adapter (BAXTER_HARNESS=custom). Drives custom-runner.ts,
// which talks to ANY keyed LLM HTTP API by swapping the wire DIALECT
// (CUSTOM_API_DIALECT=anthropic|gemini). Same JSONL event protocol as the
// openrouter/local runners, so it shares runner-events.ts. Lightweight (no SDK) --
// the HTTP work lives in the spawned runner; importing this into runtime.ts pulls
// in no model client.
import { fileURLToPath } from "node:url";
import { parseRunnerEvents, detectRunnerOutcome } from "./runner-events.ts";

const RUNNER_PATH = fileURLToPath(new URL("./custom-runner.ts", import.meta.url));

export const customHarness = {
  name: "custom",

  // Effective brain for a startup log: this harness ignores the driver's `model`
  // and reads CUSTOM_API_DIALECT/MODEL in the runner, so that's what's running.
  describe() {
    const dialect = process.env.CUSTOM_API_DIALECT || "?";
    const model = process.env.CUSTOM_API_MODEL || "CUSTOM_API_MODEL unset";
    return `${dialect}:${model}`;
  },

  buildInvocation({ allowedTools }) {
    return { command: process.execPath, args: [RUNNER_PATH, "--allowed", allowedTools ?? ""] };
  },

  parseEvents: parseRunnerEvents,
  detectOutcome: detectRunnerOutcome,
};
