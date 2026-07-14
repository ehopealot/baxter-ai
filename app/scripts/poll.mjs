#!/usr/bin/env node
// Daemon loop: watches Gmail for new mail (from whitelisted senders --
// enforcement lives in gmail.mjs's query itself) and spawns one scoped,
// headless `claude -p` run per thread. Also emails a reminder once the
// OAuth token is nearing its 7-day Testing-mode expiry. No LLM calls
// happen in this file -- loop prevention, the send cap, and the reauth
// reminder are all plain code, not instructions a run could talk itself
// out of. Mirrors the tmp-then-mv logging pattern used by
// scripts/claude-review/post-commit-review.sh in the root dev scaffold.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadSendState, MAX_SENDS_PER_DAY } from "./send-state.mjs";
import { TOKEN_PATH, REAUTH_REMINDER_PATH, MEMORY_PATH } from "./paths.mjs";
import { normalizeLineTerminators, neutralizeStructuralMarkers } from "./gmail.mjs";
import { log, logErr, sh, ensureSkills, runClaude, formatResetTime } from "./runtime.mjs";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const GMAIL_CLI_PATH = join(APP_DIR, "scripts", "gmail.mjs");
const RUNS_DIR = join(APP_DIR, ".claude", "mail-runs");
const PROMPT_PATH = join(APP_DIR, "prompt.md");
// Skills to surface to the run, copied into its cwd .claude/skills each run
// (skills resolve from cwd, which is MEMORY_DIR, not APP_DIR -- see
// ensureSkills). Two different baked locations: playwright-cli's skill is
// generated at build by `playwright-cli install --skills` under /app/.claude,
// while invisible-playwright's ships in the repo under /app/skills.
const SKILL_SRCS = [
  join(APP_DIR, ".claude", "skills", "playwright-cli"),
  join(APP_DIR, "skills", "invisible-playwright"),
];

// The claude -p run's own filesystem sandbox restricts writes to its
// working directory regardless of what --allowedTools permits -- confirmed
// by testing: an --allowedTools Write()/Edit() rule for a path outside cwd
// was still blocked. /app (this file's own APP_DIR) isn't persistent
// storage anyway (only /home/node survives container restarts, which is
// why MEMORY_PATH lives there), so the run's cwd is set to MEMORY_PATH's
// directory instead of APP_DIR, and gmail.mjs is invoked by absolute path
// since relative `scripts/gmail.mjs` would no longer resolve.
const MEMORY_DIR = dirname(MEMORY_PATH);

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_SECONDS || 60) * 1000;
const MAX_EMAILS_PER_CYCLE = Number(process.env.MAX_EMAILS_PER_CYCLE || 5);
const PERSONA_NAME = process.env.PERSONA_NAME || "Baxter Burgundy";
const GMAIL_USER_EMAIL = process.env.GMAIL_USER_EMAIL;
const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL;
// Model for the per-email runs. Sonnet is the default -- it handles Baxter's
// agentic browser + script-writing work well without Opus's cost. Set
// BAXTER_MODEL=haiku for cheaper/faster runs (fine for simple replies, riskier
// on multi-step browsing/scripting), or =opus to go back. Accepts the claude
// CLI's aliases (sonnet/haiku/opus) or a full model id.
const MODEL = process.env.BAXTER_MODEL || "sonnet";

// Google expires OAuth refresh tokens after 7 days while the app's consent
// screen is in Testing mode -- the only realistic mode here, since the
// gmail.modify/gmail.send scopes are restricted/sensitive and getting out
// of Testing would mean a paid third-party security audit. Reminds a day
// early so there's slack to actually run `make auth` before it expires.
const REAUTH_REMINDER_AFTER_MS = 6 * 24 * 60 * 60 * 1000;

function renderPrompt(thread) {
  const template = readFileSync(PROMPT_PATH, "utf8");
  // thread.body is already fully sanitized (it's built and sanitized
  // per-message inside gmail.mjs's cmdGetThread) by the time it gets
  // here, but thread.from/thread.subject are the same raw JSON fields
  // poll.mjs itself uses for the isAllowedSender re-check and logging --
  // deliberately never mutated in gmail.mjs for that reason -- so they're
  // sanitized here instead, right at the point they're substituted into
  // the prompt template's own {{FROM}}/{{SUBJECT}} slots (a sink separate
  // from, and otherwise uncovered by, the transcript body's own
  // sanitization).
  const safeFrom = neutralizeStructuralMarkers(normalizeLineTerminators(thread.from));
  const safeSubject = neutralizeStructuralMarkers(normalizeLineTerminators(thread.subject));
  return template
    .replaceAll("{{PERSONA_NAME}}", PERSONA_NAME)
    .replaceAll("{{GMAIL_USER_EMAIL}}", GMAIL_USER_EMAIL)
    .replaceAll("{{FROM}}", safeFrom)
    .replaceAll("{{SUBJECT}}", safeSubject)
    .replaceAll("{{BODY}}", thread.body)
    .replaceAll("{{MESSAGE_ID}}", thread.id)
    .replaceAll("{{MEMORY_PATH}}", MEMORY_PATH)
    .replaceAll("{{GMAIL_CLI_PATH}}", GMAIL_CLI_PATH);
}

// playwright-cli resolves its default browser from a `.playwright/`
// workspace folder it finds by walking up from its own cwd (MEMORY_DIR,
// since that's where the spawned claude -p run's Bash tool invokes it
// from) -- it never finds one there, so with no config and no --browser
// flag it falls back to the `chrome` channel, which isn't installed
// (real Google Chrome ships no Linux arm64 build; this container runs
// under Colima's arm64 VM). Writing this config makes bare `playwright-cli
// open` default to the Chromium binary that IS installed, without relying
// on the model remembering to pass --browser itself. Rewritten before
// every run rather than left to a first-run check, so it can't drift.
const PLAYWRIGHT_CONFIG_DIR = join(MEMORY_DIR, ".playwright");
function ensurePlaywrightConfig() {
  // Best-effort: this runs before runClaude's try/catch, and pollOnce
  // already labeled the thread agent-processed by this point (see the
  // comment at that call site) -- an uncaught throw here (e.g. a prior
  // run used its unscoped Write to create a plain file named .playwright,
  // so mkdirSync throws ENOTDIR) would silently drop the email forever
  // instead of merely losing the browser-default convenience.
  try {
    mkdirSync(PLAYWRIGHT_CONFIG_DIR, { recursive: true });
    writeFileSync(
      join(PLAYWRIGHT_CONFIG_DIR, "cli.config.json"),
      JSON.stringify({ browser: { browserName: "chromium", launchOptions: { channel: "chromium" } } }, null, 2),
    );
  } catch (err) {
    logErr(`Failed to write playwright config (browsing may fall back to defaults): ${err.message}`);
  }
}

// Copy the baked skills into the run's cwd .claude/skills so the spawned
// claude -p run discovers them (skills resolve from cwd, which is MEMORY_DIR
// -- confirmed by testing; the baked /app locations are outside cwd and so
// aren't loaded on their own). Refreshed each run from the image's copies so
// an edit can't be left stale, and so the run's own unscoped Write can't
// permanently corrupt them. Best-effort, and per-skill: a failure here must
// not drop the (already-labeled) email -- it only costs that skill's docs
// (the CLIs themselves still work as plain Bash commands regardless).
const CWD_SKILLS_DIR = join(MEMORY_DIR, ".claude", "skills");

// Reply in-thread that Baxter is out of tokens. Sent by plain code (no LLM),
// so it works precisely when the claude -p run couldn't. The triggering
// message is already labeled agent-processed, so the task is dropped by
// design (operator resends when they want it retried). gmail.mjs enforces the
// daily send cap; a cap/credential failure here is logged, not fatal.
async function sendOutOfTokensNotice(thread, resetsAt) {
  const when = formatResetTime(resetsAt);
  const body = when
    ? `${PERSONA_NAME} is out of tokens right now and couldn't get to this. He'll be back around ${when} -- just reply again after that and he'll pick it up.`
    : `${PERSONA_NAME} is out of tokens right now and couldn't get to this. He'll be back once his usage window resets -- just reply again later and he'll pick it up.`;
  try {
    await sh("node", ["scripts/gmail.mjs", "reply", thread.id], body);
    log(`[${thread.id}] Out of tokens -- sent notice${when ? ` (back ${when})` : ""}, task dropped.`);
  } catch (err) {
    logErr(`[${thread.id}] Failed to send out-of-tokens notice: ${err.message}`);
  }
}

// Sends at most one reminder per token generation: the marker records
// which token mtime it was sent for, and a fresh `make auth` naturally
// rewrites the token file (new mtime), which un-matches the marker and
// re-arms the check for the next cycle.
async function maybeSendReauthReminder() {
  if (!OPERATOR_EMAIL) return; // nobody to send it to -- OPERATOR_EMAIL is unset

  let tokenMtimeMs;
  try {
    tokenMtimeMs = statSync(TOKEN_PATH).mtimeMs;
  } catch {
    return; // no token yet -- nothing to remind about
  }

  if (Date.now() - tokenMtimeMs < REAUTH_REMINDER_AFTER_MS) return;

  try {
    const marker = JSON.parse(readFileSync(REAUTH_REMINDER_PATH, "utf8"));
    if (marker.tokenMtimeMs === tokenMtimeMs) return; // already reminded this generation
  } catch {
    // no marker yet, fall through and send
  }

  const ageDays = Math.floor((Date.now() - tokenMtimeMs) / (24 * 60 * 60 * 1000));
  const body = [
    `Heads up -- the Gmail OAuth token has been ${ageDays} days old.`,
    "Google expires it 7 days after issue while this app's consent screen is in Testing mode.",
    "Run `make auth` soon to reauthorize before it expires and mail stops flowing.",
  ].join("\n");

  try {
    await sh(
      "node",
      ["scripts/gmail.mjs", "send", `${PERSONA_NAME}: reauth the mail agent soon`],
      body,
    );
    mkdirSync(dirname(REAUTH_REMINDER_PATH), { recursive: true });
    writeFileSync(REAUTH_REMINDER_PATH, JSON.stringify({ tokenMtimeMs }));
    log("Sent reauth reminder.");
  } catch (err) {
    logErr(`Failed to send reauth reminder: ${err.message}`);
  }
}

async function pollOnce() {
  const listed = JSON.parse(await sh("node", ["scripts/gmail.mjs", "list-new"]));
  if (listed.length === 0) return;

  // Multiple unprocessed messages can land in the same thread within one
  // snapshot (e.g. a task plus a quick correction before the next poll).
  // get-thread resolves the newest one among these ids itself (list-new's
  // ordering isn't documented as guaranteed -- see gmail.mjs), so there's
  // only ever one meaningful representative per thread. Grouping up front,
  // rather than deduping as the loop happens to encounter siblings, means
  // every message belonging to a thread gets labeled the instant a
  // decision is made about that thread: a cap-triggered break partway
  // through the loop can no longer leave a sibling unlabeled to be
  // rediscovered -- and double-processed -- next cycle, since a thread is
  // either fully labeled or not touched at all.
  const idsByThread = new Map();
  for (const { id, threadId } of listed) {
    if (!idsByThread.has(threadId)) idsByThread.set(threadId, []);
    idsByThread.get(threadId).push(id);
  }

  async function labelAll(threadId) {
    for (const id of idsByThread.get(threadId)) {
      await sh("node", ["scripts/gmail.mjs", "label", id, "agent-processed"]);
    }
  }

  let handled = 0;

  for (const threadId of idsByThread.keys()) {
    if (handled >= MAX_EMAILS_PER_CYCLE) {
      log(`Per-cycle cap (${MAX_EMAILS_PER_CYCLE}) reached, deferring rest to next cycle.`);
      break;
    }

    // Candidate ids are passed explicitly so get-thread's "pick the newest
    // message" step is restricted to messages list-new actually returned
    // for this thread -- not every message in it (which would include the
    // agent's own replies and any non-allowlisted participant's messages,
    // either of which could otherwise outrank the real pending message and
    // get mistaken for the trigger).
    const thread = JSON.parse(
      await sh("node", ["scripts/gmail.mjs", "get-thread", threadId, ...idsByThread.get(threadId)]),
    );

    // Second, independent check against the actually-parsed From address --
    // list-new's Gmail search query matches against the whole header
    // (display name included), so `From: "allowed@x.com" <attacker@evil.com>`
    // would otherwise slip through on the query alone.
    if (!thread.isAllowedSender) {
      await labelAll(threadId);
      log(`Skipped thread ${threadId}: From (${thread.from}) doesn't match the allowlist.`);
      continue;
    }

    if (thread.isAutomated) {
      await labelAll(threadId);
      log(`Skipped automated/bulk thread ${threadId}.`);
      continue;
    }

    // Read fresh each iteration -- a run's actual sends (recorded by
    // gmail.mjs, not here) can push the count over the cap mid-cycle. Once
    // that happens it can only stay true for the rest of the cycle (the
    // count never decreases), so this is safe to treat as a hard stop
    // rather than re-checking per remaining thread.
    if (loadSendState().count >= MAX_SENDS_PER_DAY) {
      log(`Per-day send cap (${MAX_SENDS_PER_DAY}) reached, leaving the rest for tomorrow.`);
      break;
    }

    await labelAll(threadId);
    handled += 1;

    log(
      `[${thread.id}] Handling thread ${threadId} from ${thread.from}: ${thread.subject} (received ${thread.receivedAt})`,
    );
    const { outOfTokens, resetsAt } = await runClaude({
      prompt: renderPrompt(thread),
      logId: thread.id,
      cwd: MEMORY_DIR,
      model: MODEL,
      // Write/Edit are granted unscoped (path-scoped Write(<path>)/
      // Edit(<path>) rules don't actually get approved headlessly here --
      // see the MEMORY_PATH comment in paths.mjs) but cwd is MEMORY_DIR,
      // which contains only memory.md and the .playwright/ workspace
      // ensurePlaywrightConfig() writes -- so writes are bounded to
      // memory plus browser-CLI state, not the rest of the filesystem.
      // Note a run could rewrite cli.config.json itself (including
      // browser.launchOptions.executablePath/args), so that file is a
      // default we set, not a control we enforce -- consistent with this
      // project's deliberately-minimal, operational-not-permission
      // guardrail philosophy (see app/CLAUDE.md), but worth knowing.
      // gmail.mjs is referenced by absolute path since cwd is MEMORY_DIR,
      // not APP_DIR.
      // playwright-cli is the default (Chromium) browser; invisible-cli is
      // the stealth (anti-detect Firefox) path for sites that fingerprint/
      // block it. Both are documented by skills ensureSkills() drops into
      // cwd above. `Skill` is granted so the run can load a skill's full
      // command reference on demand (without it, only the one-line skill
      // description is in context).
      allowedTools: `Bash(node ${GMAIL_CLI_PATH} *) Bash(playwright-cli *) Bash(invisible-cli *) Skill Read Write Edit`,
      runsDir: RUNS_DIR,
      receivedAt: thread.receivedAt,
      beforeRun: () => {
        ensurePlaywrightConfig();
        ensureSkills(SKILL_SRCS, CWD_SKILLS_DIR);
      },
    });
    if (outOfTokens) {
      // Run couldn't proceed for lack of tokens -- reply so the sender isn't
      // left with silence. Task stays dropped (already labeled); they resend.
      await sendOutOfTokensNotice(thread, resetsAt);
    }
  }
}

async function main() {
  if (!GMAIL_USER_EMAIL) {
    logErr("GMAIL_USER_EMAIL is not set.");
    process.exit(1);
  }
  log(`Polling ${GMAIL_USER_EMAIL} every ${POLL_INTERVAL_MS / 1000}s as ${PERSONA_NAME} (model: ${MODEL}).`);
  for (;;) {
    try {
      await pollOnce();
      await maybeSendReauthReminder();
    } catch (err) {
      logErr(`Poll cycle failed: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// Only run the daemon when invoked as the CLI entry point, not on a bare
// import -- an unguarded main() would start the poll loop on import. Mirrors
// gmail.mjs.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
