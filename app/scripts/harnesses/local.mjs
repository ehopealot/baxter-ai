// Local / OpenAI-compatible harness adapter (BAXTER_HARNESS=local). Spawns
// local-runner.mjs, which drives any OpenAI chat/completions endpoint -- a
// self-hosted model (Ollama / LM Studio / llama.cpp, the default) or OpenAI /
// OpenRouter -- via OPENAI_BASE_URL / OPENAI_MODEL / OPENAI_API_KEY. Same JSONL
// event protocol as the OpenRouter runner, so it shares runner-events.mjs. Like
// openrouter.mjs, this adapter is lightweight (no model SDK) -- the HTTP work
// lives in the spawned runner.
import { fileURLToPath } from "node:url";
import { parseRunnerEvents, detectRunnerOutcome } from "./runner-events.mjs";

const RUNNER_PATH = fileURLToPath(new URL("./local-runner.mjs", import.meta.url));

export const localHarness = {
  name: "local",

  // Effective model for a startup log: this harness ignores the driver's `model`
  // and reads OPENAI_MODEL in the runner, so that's what's actually running.
  describe() {
    return process.env.OPENAI_MODEL || "OPENAI_MODEL unset";
  },

  buildInvocation({ allowedTools }) {
    return { command: process.execPath, args: [RUNNER_PATH, "--allowed", allowedTools ?? ""] };
  },

  parseEvents: parseRunnerEvents,
  detectOutcome: detectRunnerOutcome,
};
