// Shared machinery for the per-message `claude -p` agent runs, used by both
// poll.mjs (email) and discord-bot.mjs (Discord). Extracted from poll.mjs so
// the two daemons don't duplicate the spawn/stream-json/out-of-tokens logic.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

export function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
export function logErr(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

export function truncate(value, max = 300) {
  // JSON.stringify(undefined) returns the value undefined (not a string),
  // and stream-json blocks legitimately omit optional fields (e.g. an
  // empty tool_result has no `content`), so guard against a non-string
  // result before touching .length.
  const str = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

export function sh(cmd, args, input, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    // Node's spawn() defaults stdin to an open, unfed pipe. Callers that
    // pass no `input` (e.g. the plain gmail.mjs calls below that need no
    // stdin at all) would otherwise leave that pipe dangling -- claude, in
    // particular, then waits on it, warns after a timeout, and exits
    // nonzero. Ignoring stdin outright when there's nothing to write is
    // the fix the CLI's own warning suggests (`< /dev/null`).
    const child = spawn(cmd, args, {
      cwd,
      stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    // Decode as UTF-8 with partial multi-byte sequences held across chunks
    // -- otherwise a character split at a ~64 KiB pipe-chunk boundary
    // becomes U+FFFD. Matters most for get-thread, whose (unbounded,
    // frequently non-ASCII) JSON output is parsed straight into thread.body
    // and flows into the rendered prompt.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr}`));
    });
    if (input !== undefined) {
      // If the child exits before reading all of stdin (crash, expired
      // credentials, whatever), the pending write fails with EPIPE as an
      // 'error' event on the stream -- with no listener, Node treats that
      // as an uncaught exception and kills this whole daemon process, not
      // just the one poll cycle. The `close` handler above already
      // reports the real failure (exit code + stderr); this just stops
      // the write-side EPIPE from escaping as a second, fatal one.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

// Parses one line of `claude -p --output-format stream-json` output and
// echoes tool calls/results and assistant text to the daemon's own stdout
// as they happen, timestamped and tagged with logId (the Gmail message id --
// only one run happens at a time today, but tagging costs nothing and helps
// if that ever changes). stream-json requires --verbose in --print mode
// (confirmed: claude refuses to start without it), and tool_use/tool_result
// blocks only show up in this line-delimited-JSON form, not the default
// plain-text output -- no separate hook is needed for this visibility.
export function logStreamEvent(logId, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return; // partial/non-JSON line; the raw log file still keeps it verbatim
  }
  // This runs inside the stdout 'data' handler, so an uncaught throw here
  // escapes as an uncaught exception and kills the whole daemon (not just
  // this run) -- the exact silent-drop failure this file guards against
  // elsewhere. It's pure observability (the raw line is already kept in
  // rawLines regardless), so any unexpected event shape is swallowed.
  try {
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") {
          log(`[${logId}] tool_use ${block.name} ${truncate(block.input)}`);
        } else if (block.type === "text" && block.text?.trim()) {
          log(`[${logId}] text: ${truncate(block.text)}`);
        }
      }
    } else if (event.type === "user") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_result") {
          const status = block.is_error ? "ERROR" : "ok";
          log(`[${logId}] tool_result ${status} ${truncate(block.content)}`);
        }
      }
    } else if (event.type === "result") {
      log(`[${logId}] result (${event.subtype}): ${truncate(event.result ?? "")}`);
    }
  } catch (err) {
    logErr(`[${logId}] failed to log stream event: ${err.message}`);
  }
}

// Scan a finished run's stream-json lines for an out-of-tokens (usage/rate
// limit) signal, so poll.mjs can auto-reply instead of the email just being
// dropped. Primary signal: a `rate_limit_event` whose `status` is a blocking
// value -- healthy runs report `"allowed"` (verified from real output), and
// that event also carries `resetsAt` (unix seconds), the window's reset time.
// Secondary: the final `result` erroring with a 429/usage-limit flavour, in
// case a blocking rate_limit_event wasn't emitted. High-precision by design
// (won't fire on healthy runs); the exact blocking `status` string is the one
// thing not verifiable without a real outage, so this is logged loudly when it
// fires -- watch for it to confirm/tune on the first real occurrence.
// Deliberately gated on the run NOT ending in a successful terminal result:
// the status check is a deny-list of the two known-good strings, so any other
// benign status the CLI emits (or adds later) on a healthy run would otherwise
// flip outOfTokens and fire a false "couldn't get to this" notice right after
// Baxter's real reply (and burn a capped daily send). A genuinely blocked run
// can't end in a non-error result, so suppressing on success loses no real
// detection. Covered by runtime.test.mjs.
export function detectOutOfTokens(rawLines) {
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
}

// resetsAt is unix SECONDS; render it in Baxter's Pacific context for the
// notice. Null when the stream carried no reset time.
export function formatResetTime(resetsAt) {
  if (!resetsAt) return null;
  return new Date(resetsAt * 1000).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

// Copy the baked skills into the run's cwd .claude/skills so the spawned
// claude -p run discovers them (skills resolve from cwd, which is MEMORY_DIR
// -- confirmed by testing; the baked /app locations are outside cwd and so
// aren't loaded on their own). Refreshed each run from the image's copies so
// an edit can't be left stale, and so the run's own unscoped Write can't
// permanently corrupt them. Best-effort, and per-skill: a failure here must
// not drop the (already-labeled) email -- it only costs that skill's docs
// (the CLIs themselves still work as plain Bash commands regardless).
export function ensureSkills(skillSrcs, cwdSkillsDir) {
  for (const src of skillSrcs) {
    try {
      mkdirSync(cwdSkillsDir, { recursive: true });
      cpSync(src, join(cwdSkillsDir, basename(src)), { recursive: true });
    } catch (err) {
      logErr(`Failed to install skill ${basename(src)} (its CLI still works, just undocumented): ${err.message}`);
    }
  }
}

export async function runClaude({ prompt, logId, cwd, model, allowedTools, runsDir, receivedAt, beforeRun }) {
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(cwd, { recursive: true }); // must exist before it can be used as cwd
  if (beforeRun) beforeRun();
  const tmpPath = join(runsDir, `.${logId}.${process.pid}.tmp.log`);
  const finalPath = join(runsDir, `${logId}.log`);
  const startedAt = Date.now();
  const rawLines = [];
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        "claude",
        [
          "-p",
          "--model",
          model,
          // stream-json (not the default text output) is what surfaces
          // tool_use/tool_result blocks as they happen, not just the final
          // answer -- --verbose is mandatory alongside it in --print mode.
          "--output-format",
          "stream-json",
          "--verbose",
          "--allowedTools",
          allowedTools,
        ],
        {
          cwd,
          // Passed via stdin, not as a CLI argument: a whole-thread
          // transcript is effectively unbounded, and Linux caps a single
          // execve argument at MAX_ARG_STRLEN (128 KiB) -- past that, spawn
          // fails with E2BIG and, since the message is already labeled
          // agent-processed by the time this runs, the email would be
          // silently dropped with no reply. claude -p reads the prompt from
          // stdin when no argument is given (verified).
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      // Line-buffer stdout: stream-json is one JSON object per line, but
      // chunk boundaries from the 'data' event don't respect line breaks.
      // setEncoding makes Node's decoder hold back partial multi-byte
      // UTF-8 sequences until the rest of the character arrives -- without
      // it, a character split across two chunks decodes to U+FFFD in both
      // the echoed line and the raw log file.
      child.stdout.setEncoding("utf8");
      let buffer = "";
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (!line.trim()) continue;
          rawLines.push(line);
          logStreamEvent(logId, line);
        }
      });

      let stderr = "";
      child.stderr.setEncoding("utf8"); // same partial-multi-byte reason as stdout above
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (buffer.trim()) {
          rawLines.push(buffer);
          logStreamEvent(logId, buffer);
        }
        if (code === 0) resolve();
        else reject(new Error(`claude -p exited ${code}: ${stderr}`));
      });

      // See the sh() comment above for why stdin errors are swallowed here.
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  } catch (err) {
    logErr(`[${logId}] claude -p failed: ${err.message}`);
    rawLines.push(`claude -p failed: ${err.message}`);
  } finally {
    writeFileSync(tmpPath, rawLines.join("\n") + "\n");
    renameSync(tmpPath, finalPath);
    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`[${logId}] Finished in ${elapsedS}s${receivedAt ? ` (received ${receivedAt})` : ""}`);
  }
  return detectOutOfTokens(rawLines);
}
