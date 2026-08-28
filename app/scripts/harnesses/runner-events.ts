// Shared decoding of a runner's JSONL output line -> normalized events for
// runtime.ts's logEvent, plus the terminal out-of-tokens detection. Both the
// openrouter and local runners emit the same protocol ({t:"tool_use"|
// "tool_result"|"text"|"result", ...}), so both adapters (openrouter.ts /
// local.ts) share these -- one place to keep the wire format in sync.
import type { NormalizedEvent } from "../runtime.ts";
import type { UsageSrc } from "../usage-store.ts";

// Per-run model usage a runner reports on its terminal `result` event. `cost` is
// real USD (null when the provider gives none); `model` is the EFFECTIVE model
// actually run (post-escalation for openrouter), which runAgent's own `model`
// param does not know. `src` reuses the store's UsageSrc so the two unions can't
// drift. Shared by every runner + both outcome decoders.
export interface UsageReport {
  cost: number | null;
  inTok: number;
  outTok: number;
  src: UsageSrc;
  model: string;
}

// One parsed JSONL line from a runner's stdout -- the wire protocol emit()/note()
// (runner-common.ts) write and this file decodes. A genuine external-process
// boundary (the runner is a spawned child), so fields beyond `t` stay loose/
// optional and are read defensively below, same as NormalizedEvent upstream.
// Exported so custom-runner.test.ts (which spawns the runner and parses its raw
// JSONL stdout directly, same wire protocol) can reuse it instead of redefining.
export interface RunnerLine {
  t?: string;
  name?: string;
  input?: unknown;
  is_error?: boolean;
  content?: unknown;
  text?: string;
  subtype?: string;
  out_of_tokens?: boolean;
  resets_at?: number | null;
  usage?: UsageReport;
}

// The outcome detectRunnerOutcome reports -- structurally the same shape runtime.ts's
// (unexported) HarnessOutcome requires of a Harness's detectOutcome.
export interface RunnerOutcome {
  outOfTokens: boolean;
  resetsAt: number | null;
  resultText: string;
  succeeded: boolean;
  usage?: UsageReport;
}

// Decode one runner line into zero or more normalized events. Never throws (see
// claude.ts: this feeds live logging in the daemon's stdout handler).
export function parseRunnerEvents(line: string): NormalizedEvent[] {
  let e: RunnerLine;
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
      case "note": // runner-side diagnostics (e.g. a nudge/poke firing), for the log only
        return e.text ? [{ kind: "note", text: e.text }] : [];
      default:
        return [];
    }
  } catch {
    return [];
  }
}

// The runner sets out_of_tokens on its final `result` only for a 402/429 (out of
// credits / rate limited) -- the analog of Claude's usage cap. Success results
// carry out_of_tokens:false, so no success-gating is needed here.
export function detectRunnerOutcome(rawLines: string[]): RunnerOutcome {
  let outOfTokens = false;
  let resetsAt: number | null = null;
  let resultText = "";
  let succeeded = false;
  let usage: UsageReport | undefined;
  for (const line of rawLines) {
    let e: RunnerLine;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.t === "result") {
      if (e.out_of_tokens) outOfTokens = true;
      // Per-field gate on the JSON-parsed boundary value (matches this file's
      // typeof-per-scalar convention), so a malformed `usage` is dropped, not trusted.
      if (e.usage && typeof e.usage === "object" && typeof e.usage.inTok === "number" && typeof e.usage.outTok === "number") usage = e.usage;
      if (typeof e.resets_at === "number") resetsAt = e.resets_at;
      // a SUCCESS subtype = the run actually finished the task (vs the graceful
      // context-full stop, which is exit-0 + subtype "error"); capture its final
      // text for callers.
      if (e.subtype === "success") {
        succeeded = true;
        if (typeof e.text === "string") resultText = e.text;
      }
    }
  }
  // Spread `usage` only when present: an own `usage: undefined` key would break
  // existing full-object deepEqual assertions (strict) and carries no information.
  return { outOfTokens, resetsAt, resultText, succeeded, ...(usage ? { usage } : {}) };
}
