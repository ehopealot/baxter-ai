// OpenRouter harness adapter -- an entry in runtime.mjs's HARNESSES registry
// (selected by BAXTER_HARNESS=openrouter). Same shape as claude.mjs (name /
// buildInvocation / parseEvents / detectOutcome). Unlike claude (a full external
// agent binary), the "harness" here is OUR runner script (openrouter-runner.mjs,
// which runs @openrouter/agent's loop); this adapter just spawns it and decodes
// its JSONL events (shared with the local harness via runner-events.mjs).
// Deliberately lightweight + SDK-free -- importing this into runtime.mjs must NOT
// pull @openrouter/agent into the daemons; the SDK loads only in the spawned runner.
import { fileURLToPath } from "node:url";
import { parseRunnerEvents, detectRunnerOutcome } from "./runner-events.mjs";

const RUNNER_PATH = fileURLToPath(new URL("./openrouter-runner.mjs", import.meta.url));

export const openrouterHarness = {
  name: "openrouter",

  // Spawn the runner with node, prompt on stdin (like claude). The OpenRouter
  // model + key come from env (OPENROUTER_MODEL / OPENROUTER_API_KEY); only
  // allowedTools crosses, as the runner's enforced boundary.
  buildInvocation({ allowedTools }) {
    return { command: process.execPath, args: [RUNNER_PATH, "--allowed", allowedTools ?? ""] };
  },

  parseEvents: parseRunnerEvents,
  detectOutcome: detectRunnerOutcome,
};
