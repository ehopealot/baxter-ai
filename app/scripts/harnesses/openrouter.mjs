// OpenRouter harness adapter -- the second entry in runtime.mjs's HARNESSES
// registry (selected by BAXTER_HARNESS=openrouter). Same shape as claude.mjs
// (name / buildInvocation / parseEvents / detectOutcome). Unlike claude (a full
// external agent binary), the "harness" here is OUR OWN runner script
// (openrouter-runner.mjs) that runs @openrouter/agent's loop; this adapter just
// spawns it and decodes the JSONL events it prints. Deliberately lightweight and
// SDK-free -- importing this into runtime.mjs must NOT pull @openrouter/agent
// into the daemons; the SDK loads only inside the spawned runner process.
import { fileURLToPath } from "node:url";

const RUNNER_PATH = fileURLToPath(new URL("./openrouter-runner.mjs", import.meta.url));

export const openrouterHarness = {
  name: "openrouter",

  // Spawn the runner with node, prompt on stdin (like claude). The OpenRouter
  // model + key come from env (OPENROUTER_MODEL / OPENROUTER_API_KEY), so the
  // Claude-oriented `model` arg (BAXTER_MODEL, e.g. "sonnet") is irrelevant here
  // and not passed; only allowedTools crosses, as the runner's enforced boundary.
  buildInvocation({ allowedTools }) {
    return { command: process.execPath, args: [RUNNER_PATH, "--allowed", allowedTools ?? ""] };
  },

  // Decode one runner line ({t:"tool_use"|"tool_result"|"text"|"result", ...})
  // into normalized events for logEvent. Never throws (see claude.mjs).
  parseEvents(line) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return [];
    }
    try {
      switch (e.t) {
        case "tool_use":
          return [{ kind: "tool_use", name: e.name, input: e.input }];
        case "tool_result":
          return [{ kind: "tool_result", isError: !!e.is_error, content: e.content }];
        case "text":
          return e.text?.trim() ? [{ kind: "text", text: e.text }] : [];
        case "result":
          return [{ kind: "result", subtype: e.subtype, text: e.text ?? "" }];
        default:
          return [];
      }
    } catch {
      return [];
    }
  },

  // The runner sets out_of_tokens on its final `result` only for an OpenRouter
  // 402/429 (out of credits / rate limited) -- the analog of Claude's usage cap,
  // so poll.mjs's "couldn't get to this" auto-reply path fires. Success results
  // carry out_of_tokens:false, so no success-gating is needed here.
  detectOutcome(rawLines) {
    let outOfTokens = false;
    let resetsAt = null;
    for (const line of rawLines) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.t === "result") {
        if (e.out_of_tokens) outOfTokens = true;
        if (typeof e.resets_at === "number") resetsAt = e.resets_at;
      }
    }
    return { outOfTokens, resetsAt };
  },
};
