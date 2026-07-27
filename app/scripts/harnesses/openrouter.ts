// @ts-nocheck -- TS migration bridge (2026-07-27); this file is not yet typed. Remove this line and drive `tsc --noEmit` green for it in its cluster task. See docs/superpowers/plans/2026-07-27-typescript-migration.md
// OpenRouter harness adapter -- an entry in runtime.ts's HARNESSES registry
// (selected by BAXTER_HARNESS=openrouter). Same shape as claude.ts (name /
// describe / buildInvocation / parseEvents / detectOutcome). Unlike claude (a full external
// agent binary), the "harness" here is OUR runner script (openrouter-runner.ts,
// which runs @openrouter/agent's loop); this adapter just spawns it and decodes
// its JSONL events (shared with the local harness via runner-events.ts).
// Deliberately lightweight + SDK-free -- importing this into runtime.ts must NOT
// pull @openrouter/agent into the daemons; the SDK loads only in the spawned runner.
import { fileURLToPath } from "node:url";
import { parseRunnerEvents, detectRunnerOutcome } from "./runner-events.ts";

const RUNNER_PATH = fileURLToPath(new URL("./openrouter-runner.ts", import.meta.url));

export const openrouterHarness = {
  name: "openrouter",

  // Effective model for a startup log: this harness ignores the driver's `model`
  // and reads OPENROUTER_MODEL in the runner, so that's what's actually running.
  describe() {
    return process.env.OPENROUTER_MODEL || "OPENROUTER_MODEL unset";
  },

  // Spawn the runner with node, prompt on stdin (like claude). The OpenRouter
  // model + key come from env (OPENROUTER_MODEL / OPENROUTER_API_KEY); only
  // allowedTools crosses, as the runner's enforced boundary.
  buildInvocation({ allowedTools }) {
    return { command: process.execPath, args: [RUNNER_PATH, "--allowed", allowedTools ?? ""] };
  },

  parseEvents: parseRunnerEvents,
  detectOutcome: detectRunnerOutcome,
};
