// Shared machinery for the per-message `claude -p` agent runs, used by both
// poll.mjs (email) and discord-bot.mjs (Discord). Extracted from poll.mjs so
// the two daemons don't duplicate the spawn/stream-json/out-of-tokens logic.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, renameSync, readdirSync, rmSync } from "node:fs";
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
    // pass no `input` would otherwise leave that pipe dangling -- claude, in
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
// as they happen, timestamped and tagged with logId (the id of the message
// that triggered this run -- a Gmail message id for mail, a Discord message
// id for Discord; only one run happens at a time today, but tagging costs
// nothing and helps if that ever changes). stream-json requires --verbose in --print mode
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

// Fill a prompt template's `{{PLACEHOLDER}}` slots from `slots` in a SINGLE
// pass. This is the safe way to interpolate attacker-influenced values: unlike
// a chain of `String.replaceAll("{{X}}", value)`, an inserted value is never
// re-scanned, so it can't (a) trigger `$`-pattern expansion ($', $`, $$) nor
// (b) contain a `{{OTHER}}` placeholder that a later pass would fill with a real
// value (e.g. a message body embedding `{{GMAIL_CLI_PATH}}` to get the real
// path). Unknown placeholders are left intact. Used by both daemons' renderPrompt.
export function fillTemplate(template, slots) {
  // Object.hasOwn (not `key in slots`) so a placeholder can never resolve to an
  // inherited Object.prototype property.
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (Object.hasOwn(slots, key) ? slots[key] : m));
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

// Baked skill directory names across BOTH daemons (poll.mjs's SKILL_SRCS omits
// `discord`, so this is the union, not any one caller's set). A learned skill
// must never take one of these names -- see the shadow guard in ensureSkills.
// Keep in sync with the daemons' SKILL_SRCS if a baked skill is added/renamed.
const BAKED_SKILL_NAMES = new Set(["playwright-cli", "invisible-playwright", "discord", "code", "schedule"]);

// Copy the baked skills into the run's cwd .claude/skills so the spawned
// claude -p run discovers them (skills resolve from cwd, which is MEMORY_DIR
// -- confirmed by testing; the baked /app locations are outside cwd and so
// aren't loaded on their own). Refreshed each run from the image's copies so
// an edit can't be left stale, and so the run's own unscoped Write can't
// permanently corrupt them. Best-effort, and per-skill: a failure here must
// not drop the triggering run -- it only costs that skill's docs
// (the CLIs themselves still work as plain Bash commands regardless).
export function ensureSkills(skillSrcs, cwdSkillsDir, learnedSkillsDir) {
  // Best-effort like the rest of this function: a throw here would reject up
  // through beforeRun/runClaude and drop the already-labeled triggering run.
  // Creating it up front (vs inside the loop) means the prune's readdir can't
  // ENOENT; on failure the per-skill cpSyncs/learned block degrade via their
  // own catches, matching the pre-hoist path.
  try {
    mkdirSync(cwdSkillsDir, { recursive: true });
  } catch (err) {
    logErr(`Failed to create skills dir (skills undocumented this run): ${err.message}`);
  }
  for (const src of skillSrcs) {
    try {
      cpSync(src, join(cwdSkillsDir, basename(src)), { recursive: true });
    } catch (err) {
      logErr(`Failed to install skill ${basename(src)} (its CLI still works, just undocumented): ${err.message}`);
    }
  }
  if (!learnedSkillsDir) return;
  // Reserved names a learned skill may not take: BAKED_SKILL_NAMES is the
  // cross-daemon floor, and the caller's own skillSrcs are the ground truth --
  // so adding a baked skill without updating the constant can't make it vanish
  // (staged then pruned in the same call) or silently reopen the shadow hole.
  const reserved = new Set([...BAKED_SKILL_NAMES, ...skillSrcs.map((s) => basename(s))]);
  // Stage skills the agent authored itself. Claude Code guards its own .claude
  // dir against agent writes, so the run can't write into .claude/skills
  // directly -- it writes each skill under learnedSkillsDir (a plain dir in its
  // writable cwd), and this daemon (no such guard) copies each into the
  // discoverable .claude/skills. mkdir it first so the agent always has a place
  // to write. Best-effort, per-skill.
  try {
    mkdirSync(learnedSkillsDir, { recursive: true });
    const learnedNames = new Set(
      readdirSync(learnedSkillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
    for (const name of learnedNames) {
      // Never let a learned skill shadow a baked one: the run controls
      // learnedSkillsDir and its inputs are attacker-influenced, so without
      // this a `learned-skills/playwright-cli` would overwrite the baked skill
      // on every run -- persistent injection that defeats the per-run refresh.
      if (reserved.has(name)) {
        logErr(`Skipping learned skill "${name}": name is reserved for a baked skill.`);
        continue;
      }
      try {
        // Replace, not overlay, so a file deleted inside the learned skill is
        // also gone from the staged copy (learned-skills is the source of truth).
        const dest = join(cwdSkillsDir, name);
        rmSync(dest, { recursive: true, force: true });
        cpSync(join(learnedSkillsDir, name), dest, { recursive: true });
      } catch (err) {
        logErr(`Failed to stage learned skill ${name}: ${err.message}`);
      }
    }
    // Prune so learnedSkillsDir stays the source of truth: drop any staged skill
    // that is neither baked nor still in learnedSkillsDir (e.g. a learned skill
    // the operator deleted). Staging is a sync, not an accretion.
    for (const entry of readdirSync(cwdSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (reserved.has(entry.name) || learnedNames.has(entry.name)) continue;
      try {
        rmSync(join(cwdSkillsDir, entry.name), { recursive: true, force: true });
      } catch (err) {
        logErr(`Failed to prune stale staged skill ${entry.name}: ${err.message}`);
      }
    }
  } catch (err) {
    logErr(`Failed to stage learned skills: ${err.message}`);
  }
}

// Write memoryDir/.playwright/cli.config.json before a run so bare
// `playwright-cli open` defaults to the installed Chromium instead of falling
// back to the unavailable `chrome` channel (see app/CLAUDE.md). Both daemons
// call this (their runs share MEMORY_DIR). Best-effort: a throw here must not
// drop the triggering run, only the browser-default convenience -- and it's a
// default the run's unscoped Write can overwrite, not an enforced control.
export function ensurePlaywrightConfig(memoryDir) {
  const dir = join(memoryDir, ".playwright");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "cli.config.json"),
      JSON.stringify({ browser: { browserName: "chromium", launchOptions: { channel: "chromium" } } }, null, 2),
    );
  } catch (err) {
    logErr(`Failed to write playwright config (browsing may fall back to defaults): ${err.message}`);
  }
}

export async function runClaude({ prompt, logId, cwd, model, allowedTools, runsDir, receivedAt, beforeRun, env }) {
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(cwd, { recursive: true }); // must exist before it can be used as cwd
  if (beforeRun) beforeRun();
  const tmpPath = join(runsDir, `.${logId}.${process.pid}.tmp.log`);
  const finalPath = join(runsDir, `${logId}.log`);
  const startedAt = Date.now();
  const rawLines = [];
  let failed = false;
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
          // Caller may pass a filtered env (e.g. the Discord path strips
          // DISCORD_BOT_TOKEN so the run can't read it); default to inheriting.
          env: env ?? process.env,
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
    failed = true;
    logErr(`[${logId}] claude -p failed: ${err.message}`);
    rawLines.push(`claude -p failed: ${err.message}`);
  } finally {
    writeFileSync(tmpPath, rawLines.join("\n") + "\n");
    renameSync(tmpPath, finalPath);
    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`[${logId}] Finished in ${elapsedS}s${receivedAt ? ` (received ${receivedAt})` : ""}`);
  }
  // `failed` = the run hit a hard error (non-zero exit, spawn failure, missing
  // binary) -- distinct from a clean run that happened to be out of tokens. The
  // heartbeat driver needs this to reach its retry path; poll/discord ignore it.
  return { ...detectOutOfTokens(rawLines), failed };
}
