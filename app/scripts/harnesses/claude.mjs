// Claude Code harness adapter -- the ONLY harness-specific module today. It owns
// the three things that used to be hardcoded inside runtime.mjs's runClaude:
//   1. how we invoke the `claude` binary (buildInvocation),
//   2. how we decode its `stream-json` output into normalized events for the
//      generic renderer in runtime.mjs (parseEvents),
//   3. how we read its terminal usage/rate-limit signal (detectOutcome).
// runAgent (runtime.mjs) drives everything through this object's shape, so a
// second harness is a sibling file exporting the same four members
// (name / buildInvocation / parseEvents / detectOutcome) and a registry entry.
//
// DELIBERATELY NOT HERE -- two Claude-Code-isms stay caller-side (poll.mjs /
// discord-bot.mjs / heartbeat.mjs), and a second adapter must account for both:
//   * `allowedTools` -- handed to buildInvocation as an opaque string in Claude's
//     `--allowedTools` grammar. It is the ENFORCED tool-permission boundary, not
//     cosmetics: a harness without equivalent per-tool scoping cannot enforce it,
//     so swapping one in silently widens what the agent is allowed to do.
//   * skills staging into `.claude/skills` (ensureSkills, via each caller's
//     `beforeRun` hook) -- a different harness needs its own discovery/prepare.
// Both are already passed to the driver as data/hooks; leaving them caller-side
// was a deliberate seam-scope choice (see the harness-adapter design spec).

export const claudeHarness = {
  name: "claude",

  // Build the child invocation for one run. The prompt is fed on stdin by the
  // driver (a whole-thread transcript can exceed MAX_ARG_STRLEN, and claude -p
  // reads the prompt from stdin when no argument is given), so this returns only
  // the command and its args.
  buildInvocation({ model, allowedTools }) {
    return {
      command: "claude",
      args: [
        "-p",
        "--model",
        model,
        // stream-json (not the default text output) is what surfaces
        // tool_use/tool_result blocks as they happen -- --verbose is mandatory
        // alongside it in --print mode (claude refuses to start without it).
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        allowedTools,
      ],
    };
  },

  // Decode ONE stdout line into zero or more normalized events for logEvent.
  // Never throws: this feeds the daemon's live logging, and an uncaught throw in
  // the stdout handler would kill the whole daemon (not just this run). The raw
  // line is kept by the driver regardless, so any unparseable/unknown shape just
  // yields no events. One line can carry several content blocks, hence an array.
  parseEvents(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return []; // partial/non-JSON line; driver keeps it verbatim in the raw log
    }
    const out = [];
    try {
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "tool_use") {
            out.push({ kind: "tool_use", name: block.name, input: block.input });
          } else if (block.type === "text" && block.text?.trim()) {
            out.push({ kind: "text", text: block.text });
          }
        }
      } else if (event.type === "user") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "tool_result") {
            out.push({ kind: "tool_result", isError: !!block.is_error, content: block.content });
          }
        }
      } else if (event.type === "result") {
        out.push({ kind: "result", subtype: event.subtype, text: event.result ?? "" });
      }
    } catch {
      return []; // unexpected event shape -- pure observability, so swallow it
    }
    return out;
  },

  // Scan a finished run's raw stream-json lines for an out-of-tokens (usage/rate
  // limit) signal, so poll.mjs can auto-reply instead of the message being
  // dropped. Primary signal: a `rate_limit_event` whose `status` is a blocking
  // value -- healthy runs report `"allowed"`/`"allowed_warning"` (verified from
  // real output), and that event also carries `resetsAt` (unix seconds), the
  // window's reset time. Secondary: the final `result` erroring with a
  // 429/usage-limit flavour, in case a blocking rate_limit_event wasn't emitted.
  // High-precision by design (won't fire on healthy runs); the exact blocking
  // `status` string is the one thing not verifiable without a real outage, so
  // this is a deny-list of the two known-good strings -- watch the logs to
  // confirm/tune on the first real occurrence. Deliberately gated on the run NOT
  // ending in a successful terminal result: a genuinely blocked run can't end in
  // a non-error result, so suppressing on success loses no real detection while
  // preventing a false "couldn't get to this" notice (and a burned daily send)
  // right after a real reply. Covered by claude.test.mjs.
  detectOutcome(rawLines) {
    let outOfTokens = false;
    let resetsAt = null;
    let succeeded = false;
    for (const line of rawLines) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "rate_limit_event") {
        const info = e.rate_limit_info ?? {};
        if (typeof info.resetsAt === "number") resetsAt = info.resetsAt;
        if (info.status && !["allowed", "allowed_warning"].includes(info.status)) {
          outOfTokens = true;
        }
      } else if (e.type === "result") {
        if (!e.is_error) {
          succeeded = true;
          continue;
        }
        const text = String(e.result ?? "");
        if (e.api_error_status === 429 || /usage limit|rate limit|out of (usage|tokens)|too many requests/i.test(text)) {
          outOfTokens = true;
        }
      }
    }
    return { outOfTokens: outOfTokens && !succeeded, resetsAt };
  },
};
