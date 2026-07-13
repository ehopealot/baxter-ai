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
import { TOKEN_PATH, REAUTH_REMINDER_PATH } from "./paths.mjs";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNS_DIR = join(APP_DIR, ".claude", "mail-runs");
const PROMPT_PATH = join(APP_DIR, "prompt.md");

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

function sh(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: APP_DIR });
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
    .replaceAll("{{MESSAGE_ID}}", thread.id);
}

async function runClaude(prompt, logId) {
  mkdirSync(RUNS_DIR, { recursive: true });
  const tmpPath = join(RUNS_DIR, `.${logId}.${process.pid}.tmp.log`);
  const finalPath = join(RUNS_DIR, `${logId}.log`);
  try {
    const output = await sh("claude", [
      "-p",
      prompt,
      "--allowedTools",
      "Bash(node scripts/gmail.mjs *) Bash(playwright-cli *) Read",
    ]);
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
      ["scripts/gmail.mjs", "send", OPERATOR_EMAIL, `${PERSONA_NAME}: reauth the mail agent soon`],
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

  for (const { id } of listed) {
    if (handled >= MAX_EMAILS_PER_CYCLE) {
      console.log(`Per-cycle cap (${MAX_EMAILS_PER_CYCLE}) reached, deferring rest to next cycle.`);
      break;
    }

    const thread = JSON.parse(await sh("node", ["scripts/gmail.mjs", "get-thread", id]));

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
