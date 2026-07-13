#!/usr/bin/env node
// Daemon loop: watches Gmail for new mail (from whitelisted senders --
// enforcement lives in gmail.mjs's query itself) and spawns one scoped,
// headless `claude -p` run per thread. Also emails a reminder once the
// OAuth token is nearing its 7-day Testing-mode expiry. No LLM calls
// happen in this file -- loop prevention, the send cap, and the reauth
// reminder are all plain code, not instructions a run could talk itself
// out of. Mirrors the tmp-then-mv logging pattern used by
// scripts/claude-review/post-commit-review.sh in the root dev scaffold.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSendState, MAX_SENDS_PER_DAY } from "./send-state.mjs";
import { TOKEN_PATH, REAUTH_REMINDER_PATH, MEMORY_PATH } from "./paths.mjs";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const GMAIL_CLI_PATH = join(APP_DIR, "scripts", "gmail.mjs");
const RUNS_DIR = join(APP_DIR, ".claude", "mail-runs");
const PROMPT_PATH = join(APP_DIR, "prompt.md");

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

// Google expires OAuth refresh tokens after 7 days while the app's consent
// screen is in Testing mode -- the only realistic mode here, since the
// gmail.modify/gmail.send scopes are restricted/sensitive and getting out
// of Testing would mean a paid third-party security audit. Reminds a day
// early so there's slack to actually run `make auth` before it expires.
const REAUTH_REMINDER_AFTER_MS = 6 * 24 * 60 * 60 * 1000;

function sh(cmd, args, input, cwd = APP_DIR) {
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
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr}`));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function renderPrompt(thread) {
  const template = readFileSync(PROMPT_PATH, "utf8");
  return template
    .replaceAll("{{PERSONA_NAME}}", PERSONA_NAME)
    .replaceAll("{{GMAIL_USER_EMAIL}}", GMAIL_USER_EMAIL)
    .replaceAll("{{FROM}}", thread.from)
    .replaceAll("{{SUBJECT}}", thread.subject)
    .replaceAll("{{BODY}}", thread.body)
    .replaceAll("{{MESSAGE_ID}}", thread.id)
    .replaceAll("{{MEMORY_PATH}}", MEMORY_PATH)
    .replaceAll("{{GMAIL_CLI_PATH}}", GMAIL_CLI_PATH);
}

async function runClaude(prompt, logId) {
  mkdirSync(RUNS_DIR, { recursive: true });
  mkdirSync(MEMORY_DIR, { recursive: true }); // must exist before it can be used as cwd
  const tmpPath = join(RUNS_DIR, `.${logId}.${process.pid}.tmp.log`);
  const finalPath = join(RUNS_DIR, `${logId}.log`);
  try {
    const output = await sh(
      "claude",
      [
        "-p",
        // Passed via stdin, not as a CLI argument: a whole-thread transcript
        // is effectively unbounded, and Linux caps a single execve argument
        // at MAX_ARG_STRLEN (128 KiB) -- past that, spawn fails with E2BIG
        // and, since the message is already labeled agent-processed by the
        // time this runs, the email would be silently dropped with no
        // reply. claude -p reads the prompt from stdin when no argument is
        // given (verified).
        "--allowedTools",
        // Write/Edit are granted unscoped (path-scoped Write(<path>)/
        // Edit(<path>) rules don't actually get approved headlessly here --
        // see the MEMORY_PATH comment in paths.mjs) but cwd is MEMORY_DIR,
        // a directory containing nothing but memory.md, so in practice
        // they can only ever reach that one file. gmail.mjs is referenced
        // by absolute path since cwd is MEMORY_DIR, not APP_DIR.
        `Bash(node ${GMAIL_CLI_PATH} *) Bash(playwright-cli *) Read Write Edit`,
      ],
      prompt,
      MEMORY_DIR,
    );
    writeFileSync(tmpPath, output);
  } catch (err) {
    writeFileSync(tmpPath, `claude -p failed: ${err.message}`);
  } finally {
    renameSync(tmpPath, finalPath);
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
    console.log("Sent reauth reminder.");
  } catch (err) {
    console.error(`Failed to send reauth reminder: ${err.message}`);
  }
}

async function pollOnce() {
  const listed = JSON.parse(await sh("node", ["scripts/gmail.mjs", "list-new"]));
  if (listed.length === 0) return;

  let handled = 0;
  // Two unprocessed messages can land in the same thread within one
  // list-new snapshot (e.g. a task plus a quick correction before the next
  // poll). Without this, each would spawn its own run against the same
  // up-to-date transcript -- duplicate replies, the task done twice, and
  // for the earlier message specifically, a reply targeting the wrong
  // MESSAGE_ID (the transcript would already include the later message,
  // but {{FROM}}/{{SUBJECT}}/{{MESSAGE_ID}} would still describe the
  // earlier one). The thread's one dispatched run already covers every
  // message in it, so later ones in the same cycle just get labeled.
  const handledThreadIds = new Set();

  for (const { id, threadId } of listed) {
    if (handled >= MAX_EMAILS_PER_CYCLE) {
      console.log(`Per-cycle cap (${MAX_EMAILS_PER_CYCLE}) reached, deferring rest to next cycle.`);
      break;
    }

    if (handledThreadIds.has(threadId)) {
      await sh("node", ["scripts/gmail.mjs", "label", id, "agent-processed"]);
      console.log(`Skipped ${id}: thread ${threadId} already handled this cycle.`);
      continue;
    }

    const thread = JSON.parse(await sh("node", ["scripts/gmail.mjs", "get-thread", id, threadId]));

    // Second, independent check against the actually-parsed From address --
    // list-new's Gmail search query matches against the whole header
    // (display name included), so `From: "allowed@x.com" <attacker@evil.com>`
    // would otherwise slip through on the query alone.
    if (!thread.isAllowedSender) {
      await sh("node", ["scripts/gmail.mjs", "label", id, "agent-processed"]);
      console.log(`Skipped ${id}: From (${thread.from}) doesn't match the allowlist.`);
      continue;
    }

    if (thread.isAutomated) {
      await sh("node", ["scripts/gmail.mjs", "label", id, "agent-processed"]);
      console.log(`Skipped automated/bulk message ${id}.`);
      continue;
    }

    // Read fresh each iteration -- a run's actual sends (recorded by
    // gmail.mjs, not here) can push the count over the cap mid-cycle. Once
    // that happens it can only stay true for the rest of the cycle (the
    // count never decreases), so this is safe to treat as a hard stop
    // rather than re-checking per remaining message.
    if (loadSendState().count >= MAX_SENDS_PER_DAY) {
      console.log(`Per-day send cap (${MAX_SENDS_PER_DAY}) reached, leaving the rest for tomorrow.`);
      break;
    }

    await sh("node", ["scripts/gmail.mjs", "label", id, "agent-processed"]);
    handledThreadIds.add(threadId);
    handled += 1;

    console.log(`Handling ${id} from ${thread.from}: ${thread.subject}`);
    await runClaude(renderPrompt(thread), id);
  }
}

async function main() {
  if (!GMAIL_USER_EMAIL) {
    console.error("GMAIL_USER_EMAIL is not set.");
    process.exit(1);
  }
  console.log(`Polling ${GMAIL_USER_EMAIL} every ${POLL_INTERVAL_MS / 1000}s as ${PERSONA_NAME}.`);
  for (;;) {
    try {
      await pollOnce();
      await maybeSendReauthReminder();
    } catch (err) {
      console.error(`Poll cycle failed: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
