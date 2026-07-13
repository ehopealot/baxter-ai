#!/usr/bin/env node
// Daemon loop: watches Gmail for new mail and spawns one scoped, headless
// `claude -p` run per thread. No LLM calls happen in this file -- loop
// prevention and the send cap are plain code, not instructions a run could
// talk itself out of. Mirrors the tmp-then-mv logging pattern used by
// scripts/claude-review/post-commit-review.sh in the root dev scaffold.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSendState } from "./send-state.mjs";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNS_DIR = join(APP_DIR, ".claude", "mail-runs");
const PROMPT_PATH = join(APP_DIR, "prompt.md");

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_SECONDS || 60) * 1000;
const MAX_EMAILS_PER_CYCLE = Number(process.env.MAX_EMAILS_PER_CYCLE || 5);
const MAX_SENDS_PER_DAY = Number(process.env.MAX_SENDS_PER_DAY || 50);
const PERSONA_NAME = process.env.PERSONA_NAME || "Baxter Burgundy";
const GMAIL_USER_EMAIL = process.env.GMAIL_USER_EMAIL;

function sh(cmd, args) {
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
    } catch (err) {
      console.error(`Poll cycle failed: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
