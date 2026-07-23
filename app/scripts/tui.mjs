#!/usr/bin/env node
// Baxter TUI -- an interactive terminal (`baxter shell`). A plain line CHATS with
// Baxter (a fresh run per turn, streamed live); a `/slash` line runs one of his
// tools directly, or a meta command. Thin I/O shell over the pure tui-core.mjs.
import readline from "node:readline";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, ensureSkills, ensurePlaywrightConfig, fillTemplate, harnessLabel, skillsPreamble, redactToolInput } from "./runtime.mjs";
import { parseTuiInput, resolveSlash, SLASH_TOOLS, META_COMMANDS, renderEvent, keyFilesToWrite, isBodyTerminator } from "./tui-core.mjs";
import { TUI_TOOLS, TUI_SKILL_SRCS, TUI_SKILL_NAMES, loadedSkillsList } from "./grants.mjs";
import { MEMORY_DIR, MEMORY_PATH, CREDENTIALS_PATH, LEARNED_SKILLS_DIR } from "./paths.mjs";
import { projectsPreamble } from "./projects-cli.mjs";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNS_DIR = join(APP_DIR, ".claude", "tui-runs");
const CWD_SKILLS_DIR = join(MEMORY_DIR, ".claude", "skills");
const PROMPT_PATH = join(APP_DIR, "tui-prompt.md");
const MODEL = process.env.BAXTER_MODEL || "sonnet";
const PERSONA_NAME = process.env.PERSONA_NAME || "Baxter Burgundy";

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const out = (s) => process.stdout.write(s + "\n");

// --- startup: credential files + skills (so chat runs auth and /skill works) ---
// runAgent strips AGENTMAIL_API_KEY/DISCORD_BOT_TOKEN from the run env; mail.mjs
// /discord-cli fall back to these 0600 files (same as poll/discord/heartbeat).
for (const { path, contents } of keyFilesToWrite(process.env)) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: 0o600 });
}
ensurePlaywrightConfig(MEMORY_DIR);
ensureSkills(TUI_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR);

// --- chat: a fresh run per turn, streamed live via onEvent ---
let chatSeq = 0;

function renderChatPrompt(message) {
  return fillTemplate(readFileSync(PROMPT_PATH, "utf8"), {
    PERSONA_NAME,
    MESSAGE: message,
    MEMORY_PATH,
    CREDENTIALS_PATH,
    LEARNED_SKILLS_DIR,
    PROJECTS_LIST: projectsPreamble(),
    LOADED_SKILLS: loadedSkillsList(TUI_SKILL_NAMES),
    LEARNED_SKILLS_LIST: skillsPreamble(),
  });
}

async function runChat(message) {
  const { outOfTokens, failed } = await runAgent({
    prompt: renderChatPrompt(message),
    logId: `tui-${process.pid}-${chatSeq++}`,
    cwd: MEMORY_DIR,
    model: MODEL,
    allowedTools: TUI_TOOLS,
    runsDir: RUNS_DIR,
    logEvents: false, // we render via onEvent; the daemon logEvent would double every line
    env: { ...process.env },
    beforeRun: () => {
      ensurePlaywrightConfig(MEMORY_DIR);
      ensureSkills(TUI_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR);
    },
    onEvent: (ev) => {
      // Redact typed secrets (browser type/fill password args) before rendering, the
      // same guard logEvent applies -- else a login run echoes the credential to the
      // operator's terminal/scrollback. redactToolInput no-ops non-tool_use events.
      const safe = ev.kind === "tool_use" ? { ...ev, input: redactToolInput(ev.input) } : ev;
      const line = renderEvent(safe);
      if (line) out(safe.kind === "text" ? line : dim(line));
    },
  });
  // A hard-failed run (nonzero exit / spawn failure) emits no renderable event -- the
  // reason goes only to the raw log -- so without this the turn would be silent.
  if (failed) out(dim("(run failed — see the raw log in .claude/tui-runs/)"));
  if (outOfTokens) out(dim(`(${PERSONA_NAME} is out of tokens right now.)`));
}

// --- slash tool passthrough: spawn a CLI directly (argv, no shell) ---
function runTool(argv, stdinBody) {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, {
      stdio: [stdinBody != null ? "pipe" : "ignore", "inherit", "inherit"],
      env: process.env,
      cwd: MEMORY_DIR,
    });
    if (stdinBody != null) {
      // A child that validates args before reading stdin (e.g. `code-cli rust` errors
      // immediately) can exit before draining -> EPIPE. Swallow it (matches sh() in
      // runtime.mjs); child.on("error") does NOT catch stream-level errors.
      child.stdin.on("error", () => {});
      child.stdin.end(stdinBody);
    }
    child.on("close", () => resolve());
    child.on("error", (e) => { out(`error: ${e.message}`); resolve(); });
  });
}

// --- meta commands (handled in-process) ---
function printFile(path, fallback) {
  let text;
  try { text = readFileSync(path, "utf8"); }
  catch { out(dim(fallback)); return; }
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

function handleMeta(verb, args) {
  switch (verb) {
    case "help": printHelp(); break;
    case "tools":
      out("slash tools: " + Object.keys(SLASH_TOOLS).map((v) => "/" + v).join(" "));
      out("meta:        " + [...META_COMMANDS].map((v) => "/" + v).join(" "));
      break;
    case "memory": printFile(MEMORY_PATH, "(memory is empty)"); break;
    case "skill":
      if (!args[0]) {
        const learned = skillsPreamble();
        out(dim("baked:   ") + TUI_SKILL_NAMES.join(", "));
        out(dim("learned: ") + (learned === "(none yet)" ? "(none yet)" : learned.split("\n").map((l) => l.replace(/^- /, "")).join(", ")));
        out(dim("open one with /skill <name>"));
        break;
      }
      // Re-stage first so an in-session edit is reflected: a chat run that just
      // rewrote a learned skill only wrote the SOURCE (learned-skills/); the staged
      // copy load_skill reads is otherwise refreshed only at the next run's start.
      // This makes `/skill <name>` a live reload (and matches what Baxter loads next).
      ensureSkills(TUI_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR);
      printFile(join(CWD_SKILLS_DIR, basename(args[0]), "SKILL.md"), `(no skill '${args[0]}')`);
      break;
    case "harness": out(`harness: ${harnessLabel(MODEL)} (BAXTER_HARNESS=${process.env.BAXTER_HARNESS || "claude"})`); break;
    case "clear": process.stdout.write("\x1b[2J\x1b[H"); break;
    case "exit": exiting = true; rl.close(); break;
  }
}

function printHelp() {
  out(bold("Baxter TUI"));
  out("  <text>                 chat with Baxter (a fresh run each time)");
  out("  /<tool> ...            run a tool directly: " + Object.keys(SLASH_TOOLS).map((v) => "/" + v).join(", "));
  out(dim("                        a bare /projects /schedule /files /data /mail /discord lists its set"));
  out("  /code <lang>           enter code; end with a lone '.'  (or /code <lang> --file <path>)");
  out("  /skill [name]          list your skills, or open one  (alias: /load_skill)");
  out("  /memory  /tools  /harness  /clear  /exit");
  out("  //text                 chat a message that starts with a slash");
}

// --- REPL ---
let collecting = null;      // { argv } while gathering a /code body
const bodyLines = [];
let exiting = false;        // set ONLY by /exit -> drop turns queued after it
let draining = false;       // set by the close handler -> silence reprompt during drain

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function reprompt() {
  if (draining) return; // no dangling prompt (and no stdin resume) during the exit drain
  rl.setPrompt(collecting ? dim("… ") : bold("baxter› "));
  rl.prompt();
}

async function handle(raw) {
  if (collecting) {
    if (isBodyTerminator(raw)) {
      const argv = collecting.argv;
      collecting = null;
      const body = bodyLines.join("\n") + "\n";
      bodyLines.length = 0;
      await runTool(argv, body);
    } else {
      bodyLines.push(raw);
    }
    return;
  }
  const p = parseTuiInput(raw);
  if (p.kind === "blank") return;
  if (p.kind === "chat") return runChat(p.text);
  const r = resolveSlash(p.verb, p.args);
  if (r.type === "error") return out(r.message);
  if (r.type === "meta") return handleMeta(r.verb, r.args);
  if (r.body) { collecting = { argv: r.argv }; out(dim("… enter code; end with a lone '.'")); return; }
  return runTool(r.argv, null);
}

// Serialize turns through a promise chain, NOT rl.pause(): readline emits one `line`
// event per line of a PASTED chunk synchronously, before pause() can take effect, so a
// pasted multi-line message would otherwise start N concurrent runs. The chain runs
// each turn strictly after the previous finishes.
let queue = Promise.resolve();
rl.on("line", (raw) => {
  queue = queue.then(async () => {
    if (exiting) return; // a prior /exit -> drop the rest of a pasted/piped chunk (shell exit semantics)
    try { await handle(raw); } catch (e) { out(`error: ${e.message}`); }
    reprompt();
  });
});
rl.on("close", async () => {
  draining = true;
  // Finish any in-flight/queued turn before exiting -- otherwise Ctrl-D (or EOF on
  // piped input) mid-run kills a chat run that was still streaming.
  try { await queue; } catch { /* exiting anyway */ }
  // Ctrl-D mid /code submits the body (spec + heredoc habit), rather than dropping it.
  if (collecting) {
    const { argv } = collecting;
    collecting = null;
    const body = bodyLines.join("\n") + "\n";
    bodyLines.length = 0;
    try { await runTool(argv, body); } catch { /* exiting anyway */ }
  }
  out("\nbye");
  process.exit(0);
});

out(bold(`${PERSONA_NAME} — terminal`) + dim(`  (${harnessLabel(MODEL)})`));
out(dim("chat, or /help for commands. /exit or Ctrl-D to quit."));
reprompt();
