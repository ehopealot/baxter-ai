// @ts-nocheck -- TS migration bridge (2026-07-27); this file is not yet typed. Remove this line and drive `tsc --noEmit` green for it in its cluster task. See docs/superpowers/plans/2026-07-27-typescript-migration.md
// OpenAI-style harness adapter (BAXTER_HARNESS=openai; `local` is a back-compat alias).
// Spawns local-runner.ts, which drives any OpenAI chat/completions endpoint -- a
// self-hosted model (Ollama / LM Studio / llama.cpp, the default) OR a remote one (OpenAI
// / OpenRouter / any compatible host) -- via OPENAI_BASE_URL / OPENAI_MODEL / OPENAI_API_KEY
// (a REMOTE endpoint needs the key). Same JSONL event protocol as the OpenRouter runner,
// so it shares runner-events.ts. Lightweight (no model SDK) -- the HTTP work lives in the
// spawned runner. (Files stay named local*.ts; only the user-facing name changed.)
import { fileURLToPath } from "node:url";
import { parseRunnerEvents, detectRunnerOutcome } from "./runner-events.ts";

const RUNNER_PATH = fileURLToPath(new URL("./local-runner.ts", import.meta.url));

export const localHarness = {
  name: "openai",

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
