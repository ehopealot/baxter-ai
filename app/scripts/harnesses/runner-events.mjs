// Shared decoding of a runner's JSONL output line -> normalized events for
// runtime.mjs's logEvent, plus the terminal out-of-tokens detection. Both the
// openrouter and local runners emit the same protocol ({t:"tool_use"|
// "tool_result"|"text"|"result", ...}), so both adapters (openrouter.mjs /
// local.mjs) share these -- one place to keep the wire format in sync.

// Decode one runner line into zero or more normalized events. Never throws (see
// claude.mjs: this feeds live logging in the daemon's stdout handler).
export function parseRunnerEvents(line) {
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
}

// The runner sets out_of_tokens on its final `result` only for a 402/429 (out of
// credits / rate limited) -- the analog of Claude's usage cap. Success results
// carry out_of_tokens:false, so no success-gating is needed here.
export function detectRunnerOutcome(rawLines) {
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
}
