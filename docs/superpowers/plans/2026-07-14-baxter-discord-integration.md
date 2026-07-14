# Baxter × Discord Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Discord presence to the Baxter Burgundy agent: a discord.js gateway daemon that, per triggering message, spawns a scoped `claude -p` run whose context is the channel's message history plus per-channel memory, able to do anything on the server except manage membership.

**Architecture:** A new `discord-bot.mjs` gateway daemon runs as its own container from the same `app/` image, sharing the config volume with the mail poller. It receives `messageCreate` events, decides whether to respond (structural pre-checks → cheap Haiku pre-filter → full Sonnet run), and spawns the run exactly as `poll.mjs` does. The run acts on Discord only through a token-scoped `discord-cli.mjs` (Discord REST API), mirroring how `gmail.mjs` is the sole credential holder for email. Shared spawn/logging/claude-run machinery is factored out of `poll.mjs` into a `runtime.mjs` module both daemons import.

**Tech Stack:** Node 22 (ESM, `"type": "module"`), discord.js v14, Discord REST API v10 (via global `fetch`), `node:test` for unit tests, `claude` CLI (`-p` headless, models `sonnet`/`haiku`), Docker.

## Global Constraints

- **discord.js v14** (`^14`); requires Node ≥16.11 (we run Node 22). Used only in `discord-bot.mjs` (gateway). `discord-cli.mjs` uses raw `fetch` to `https://discord.com/api/v10`, no discord.js import.
- **Credential boundary:** only `discord-bot.mjs` and `discord-cli.mjs` read `DISCORD_BOT_TOKEN`. The spawned `claude -p` run never receives the token; it reaches Discord only via `Bash(discord-cli *)`.
- **Gateway intents:** `Guilds`, `GuildMessages`, `MessageContent` (privileged — must be enabled in the Developer Portal), `DirectMessages`, `GuildMessageReactions`. Partials: `Channel`, `Message`, `Reaction`.
- **Permissions denied (not exposed by `discord-cli`, not granted on the bot):** Create Invite, Kick Members, Ban Members, Manage Roles, Manage Channels, Manage Guild, Administrator, Moderate Members. Everything else granted.
- **Attacker-influenced text** (any Discord message body/author name) must pass through `normalizeLineTerminators` then `neutralizeStructuralMarkers` (imported from `gmail.mjs`) before entering a prompt.
- **Default env values:** `DISCORD_MAX_SENDS_PER_DAY=1000`, `DISCORD_HISTORY_LIMIT=200`, `DISCORD_PREFILTER_HISTORY=30`, `DISCORD_DEBOUNCE_MS=4000`, `DISCORD_MAX_CONCURRENT_RUNS=5`, `DISCORD_TRIGGER_ON_BOTS=false`, `DISCORD_GUILD_ALLOWLIST=` (empty = any invited guild). Unset `DISCORD_BOT_TOKEN` cleanly disables the bot.
- **Discord limits:** a single message is ≤2000 chars (chunk longer sends); `GET /channels/{id}/messages` returns ≤100 per request (paginate with `before`).
- **Persistence:** the Discord run's cwd is the same `MEMORY_DIR` (`~/.mail-agent/memory-workspace/`) the email run uses, so shared memory, ad-hoc skills, and the `.claude/skills` dir are shared. Per-channel memory lives at `MEMORY_DIR/discord/<channelId>.md` (inside cwd, so the sandbox permits writes).
- **Entry-point guard:** every daemon/CLI file guards its top-level dispatch with `if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)` so importing its functions in tests doesn't start the daemon (as `poll.mjs`/`gmail.mjs` do).
- **Commit trailers:** end each commit message with the two lines this repo uses:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_013R7GwxgVf6Rg1T1Yvr7rZg`.
- **Running unit tests:** the dev container lacks `google-auth-library`/`discord.js` (they live in the built app image). Run `node --test` inside the image via the throwaway-container pattern in Task 0's verification, OR for files that import nothing from `gmail.mjs`/`discord.js`, run directly with `node --test` in the container.

---

## File Structure

**Created:**
- `app/scripts/runtime.mjs` — shared machinery extracted from `poll.mjs`: `log`, `logErr`, `truncate`, `sh`, `logStreamEvent`, `detectOutOfTokens`, `formatResetTime`, `ensureSkills`, `runClaude`.
- `app/scripts/runtime.test.mjs` — unit tests for the pure functions moved into `runtime.mjs`.
- `app/scripts/discord-cli.mjs` — token-scoped Discord REST CLI the run invokes.
- `app/scripts/discord-cli.test.mjs` — unit tests for `discord-cli` pure helpers (chunking, emoji encode, arg parse).
- `app/scripts/discord-bot.mjs` — the gateway daemon (event handling, response gate, debounce/queue, pre-filter, run dispatch).
- `app/scripts/discord-bot.test.mjs` — unit tests for the response-gate and debounce/queue pure logic.
- `app/discord-prompt.md` — the per-message prompt template for the Discord full run.
- `app/skills/discord/SKILL.md` — the `discord` skill documenting `discord-cli`, conventions, memory, and ad-hoc skills.

**Modified:**
- `app/scripts/poll.mjs` — import the extracted functions from `runtime.mjs` instead of defining them locally.
- `app/scripts/poll.test.mjs` — delete (its tests move to `runtime.test.mjs`), or repoint imports; this plan deletes it and recreates the cases in `runtime.test.mjs`.
- `app/scripts/paths.mjs` — add `DISCORD_STATE_DIR`, `DISCORD_SEND_STATE_PATH`, `MEMORY_DIR`, and `discordChannelMemoryPath(channelId)`.
- `app/scripts/send-state.mjs` — refactor to an internal counter factory; keep existing email exports and add `DISCORD_MAX_SENDS_PER_DAY`, `loadDiscordSendState`, `recordDiscordSend`.
- `app/package.json` — add `discord.js` dependency.
- `app/Dockerfile` — no code change needed if `npm install` already runs after `COPY package.json` (verify); adds discord.js via the dependency.
- `app/.env.example` — add the `DISCORD_*` vars.
- `Makefile` — add the `discord` target.
- `app/CLAUDE.md` — document the Discord integration.

---

## Task 0: Add discord.js dependency and confirm the test harness

**Files:**
- Modify: `app/package.json`
- Verify: `app/Dockerfile:53-54`

**Interfaces:**
- Produces: a built `app` image containing `discord.js` and able to run `node --test`.

- [ ] **Step 1: Add the dependency**

Edit `app/package.json` `dependencies` to:

```json
  "dependencies": {
    "discord.js": "^14.16.3",
    "google-auth-library": "^9.15.0"
  }
```

- [ ] **Step 2: Confirm the Dockerfile installs it**

Read `app/Dockerfile` lines 53-54. Confirm they are:

```dockerfile
COPY package.json ./
RUN npm install --omit=dev
```

`discord.js` is a runtime (not dev) dependency, so `--omit=dev` keeps it. No Dockerfile edit needed. If line 54 instead pruned prod deps, that would be a problem — verify it does not.

- [ ] **Step 3: Build the image**

Run: `make build-app`
Expected: build succeeds; the `discord.js` install appears in the `npm install` layer.

- [ ] **Step 4: Confirm discord.js loads and `node --test` works in the image**

Run:
```bash
docker run --rm app-app:latest node -e "import('discord.js').then(m=>console.log('discord.js', m.version))"
```
Expected: prints `discord.js 14.x.x`.

- [ ] **Step 5: Commit**

```bash
git add app/package.json
git commit -m "Add discord.js dependency for the Discord bot"
```

---

## Task 1: Extract shared runtime module from poll.mjs

Factor the spawn/logging/claude-run machinery out of `poll.mjs` so `discord-bot.mjs` can reuse it without duplication. This is a pure refactor: `poll.mjs`'s behavior must not change.

**Files:**
- Create: `app/scripts/runtime.mjs`
- Create: `app/scripts/runtime.test.mjs`
- Modify: `app/scripts/poll.mjs`
- Delete: `app/scripts/poll.test.mjs`

**Interfaces:**
- Produces (from `runtime.mjs`):
  - `log(msg)`, `logErr(msg)` — timestamped console writers.
  - `truncate(value, max=300)` → string.
  - `sh(cmd, args, input, cwd)` → `Promise<string>` (stdout; rejects on nonzero exit).
  - `logStreamEvent(logId, line)` → void (echoes parsed stream-json to stdout).
  - `detectOutOfTokens(rawLines: string[])` → `{ outOfTokens: boolean, resetsAt: number|null }`.
  - `formatResetTime(resetsAt)` → string|null.
  - `ensureSkills(skillSrcs: string[], cwdSkillsDir: string)` → void.
  - `runClaude({ prompt, logId, cwd, model, allowedTools, runsDir, receivedAt, beforeRun })` → `Promise<{ outOfTokens, resetsAt }>`. `beforeRun` is an optional `() => void` callback run after dirs are ensured but before spawn (used by `poll.mjs` for `ensurePlaywrightConfig`/`ensureSkills`).

- [ ] **Step 1: Create runtime.mjs with the moved functions**

Create `app/scripts/runtime.mjs`. Move the bodies of `log`, `logErr`, `truncate`, `sh`, `logStreamEvent`, `detectOutOfTokens`, `formatResetTime` **verbatim** from `poll.mjs` (lines 61-75, 77-117, 200-283 region), and generalize `ensureSkills` and `runClaude` to take parameters instead of reading module-level constants. Header:

```js
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
```

Then paste `truncate`, `sh` (default `cwd` param stays but callers now pass it explicitly — keep the signature `sh(cmd, args, input, cwd = process.cwd())`), `logStreamEvent`, `detectOutOfTokens`, `formatResetTime` unchanged except adding `export` to each. Generalize `ensureSkills`:

```js
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
```

Generalize `runClaude` (move the body from `poll.mjs:315-420`), replacing module constants with params:

```js
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
        ["-p", "--model", model, "--output-format", "stream-json", "--verbose", "--allowedTools", allowedTools],
        { cwd, stdio: ["pipe", "pipe", "pipe"] },
      );
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
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (buffer.trim()) { rawLines.push(buffer); logStreamEvent(logId, buffer); }
        if (code === 0) resolve();
        else reject(new Error(`claude -p exited ${code}: ${stderr}`));
      });
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
```

Preserve all the explanatory comments from `poll.mjs` (the stdin/EPIPE, UTF-8, stream-json, E2BIG-via-stdin notes) on the corresponding lines — they document real bugs.

- [ ] **Step 2: Create runtime.test.mjs (the moved poll tests)**

Create `app/scripts/runtime.test.mjs` with the 10 test cases currently in `poll.test.mjs`, changing the import to `from "./runtime.mjs"`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectOutOfTokens, formatResetTime } from "./runtime.mjs";
```

Copy the 10 `test(...)` blocks verbatim from `poll.test.mjs` (healthy run, allowed_warning, blocking status, bare 429, usage-limit text, success-suppresses-stray-status, non-JSON skipped, no-signal defaults, formatResetTime null, formatResetTime Pacific string).

- [ ] **Step 3: Delete the old test file and rewire poll.mjs**

Delete `app/scripts/poll.test.mjs`. In `poll.mjs`:
- Remove the local definitions of `log`, `logErr`, `truncate`, `sh`, `logStreamEvent`, `detectOutOfTokens`, `formatResetTime`, `ensureSkills`, and the big `runClaude` body.
- Add near the top: `import { log, logErr, sh, ensureSkills, runClaude } from "./runtime.mjs";` (import only what poll.mjs still uses; `truncate`/`logStreamEvent`/`detectOutOfTokens`/`formatResetTime` are used internally by runtime now — but `poll.mjs`'s `runClaude` call returns `{outOfTokens, resetsAt}` so it no longer needs `detectOutOfTokens` directly).
- Replace `poll.mjs`'s `runClaude(prompt, logId, receivedAt)` call site with:

```js
const { outOfTokens, resetsAt } = await runClaude({
  prompt: renderPrompt(thread),
  logId: thread.id,
  cwd: MEMORY_DIR,
  model: MODEL,
  allowedTools: `Bash(node ${GMAIL_CLI_PATH} *) Bash(playwright-cli *) Bash(invisible-cli *) Skill Read Write Edit`,
  runsDir: RUNS_DIR,
  receivedAt: thread.receivedAt,
  beforeRun: () => { ensurePlaywrightConfig(); ensureSkills(SKILL_SRCS, CWD_SKILLS_DIR); },
});
```

- Keep `ensurePlaywrightConfig`, `renderPrompt`, `SKILL_SRCS`, `CWD_SKILLS_DIR`, `MEMORY_DIR`, `RUNS_DIR`, `MODEL`, `GMAIL_CLI_PATH` in `poll.mjs`.
- `sendOutOfTokensNotice` in `poll.mjs` still uses `formatResetTime` — import it too: add `formatResetTime` to the runtime import.

- [ ] **Step 4: Run the moved unit tests**

Build and run in the image (dev container lacks google-auth-library, but runtime.mjs imports none of it, so run directly):
```bash
make build-app
docker run --rm app-app:latest node --test scripts/runtime.test.mjs
```
Expected: `# pass 10  # fail 0`.

- [ ] **Step 5: Smoke-test poll.mjs still starts**

```bash
docker run --rm --entrypoint node app-app:latest scripts/poll.mjs 2>&1 | head -2
```
Expected: `[timestamp] GMAIL_USER_EMAIL is not set.` and exit 1 (the entry guard still fires `main()`; no crash from the refactor).

- [ ] **Step 6: Commit**

```bash
git add app/scripts/runtime.mjs app/scripts/runtime.test.mjs app/scripts/poll.mjs
git rm app/scripts/poll.test.mjs
git commit -m "Extract shared claude-run machinery into runtime.mjs"
```

---

## Task 2: Add a Discord daily send-cap counter

Give Discord its own daily send counter, separate from email, reusing `send-state.mjs`'s pattern via an internal factory so the two share logic.

**Files:**
- Modify: `app/scripts/paths.mjs`
- Modify: `app/scripts/send-state.mjs`
- Create: `app/scripts/send-state.test.mjs`

**Interfaces:**
- Consumes: `SEND_STATE_PATH` (existing), new `DISCORD_SEND_STATE_PATH`.
- Produces: existing `MAX_SENDS_PER_DAY`, `loadSendState()`, `recordSend()` unchanged in signature; new `DISCORD_MAX_SENDS_PER_DAY`, `loadDiscordSendState()`, `recordDiscordSend()` with the same shapes (`{date, count}`).

- [ ] **Step 1: Add the Discord state path**

In `app/scripts/paths.mjs`, after the `SEND_STATE_PATH` line add:

```js
export const DISCORD_SEND_STATE_PATH = join(STATE_DIR, "discord-send-state.json");
```

- [ ] **Step 2: Write the failing test**

Create `app/scripts/send-state.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMaxSends } from "./send-state.mjs";

test("parseMaxSends returns default on unset/blank", () => {
  assert.equal(parseMaxSends(undefined, 500), 500);
  assert.equal(parseMaxSends("", 500), 500);
  assert.equal(parseMaxSends("   ", 500), 500);
});
test("parseMaxSends parses a valid number", () => {
  assert.equal(parseMaxSends("1000", 500), 1000);
  assert.equal(parseMaxSends("0", 500), 0);
});
test("parseMaxSends falls back on NaN or negative", () => {
  assert.equal(parseMaxSends("fifty", 500), 500);
  assert.equal(parseMaxSends("-3", 500), 500);
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
docker run --rm app-app:latest node --test scripts/send-state.test.mjs
```
Expected: FAIL — `parseMaxSends` is not exported yet.

- [ ] **Step 4: Refactor send-state.mjs to a factory**

Rewrite `app/scripts/send-state.mjs` so the parse logic is a pure exported helper and the counter is built by a factory used twice:

```js
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SEND_STATE_PATH, DISCORD_SEND_STATE_PATH } from "./paths.mjs";

// Pure: resolve a daily cap from an env string, with the same guards the
// project has always used (blank -> default, since Number("") is 0; NaN or
// negative -> default rather than a silent 0-cap lockout; 0 kept as an
// explicit kill switch).
export function parseMaxSends(raw, defaultMax) {
  if (raw === undefined || raw.trim() === "") return defaultMax;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`Invalid send cap "${raw}", falling back to ${defaultMax}.`);
    return defaultMax;
  }
  return parsed;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Builds a { MAX, load, record } counter over one JSON file + one env var.
function createCounter(path, envVar, defaultMax) {
  const MAX = parseMaxSends(process.env[envVar], defaultMax);
  function load() {
    try {
      const state = JSON.parse(readFileSync(path, "utf8"));
      return state.date === todayUTC() ? state : { date: todayUTC(), count: 0 };
    } catch {
      return { date: todayUTC(), count: 0 };
    }
  }
  function record() {
    const state = load();
    state.count += 1;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
    return state;
  }
  return { MAX, load, record };
}

const email = createCounter(SEND_STATE_PATH, "MAX_SENDS_PER_DAY", 500);
export const MAX_SENDS_PER_DAY = email.MAX;
export const loadSendState = email.load;
export const recordSend = email.record;

const discord = createCounter(DISCORD_SEND_STATE_PATH, "DISCORD_MAX_SENDS_PER_DAY", 1000);
export const DISCORD_MAX_SENDS_PER_DAY = discord.MAX;
export const loadDiscordSendState = discord.load;
export const recordDiscordSend = discord.record;
```

The existing email exports keep their names and shapes, so `gmail.mjs` and `poll.mjs` need no change.

- [ ] **Step 5: Run the test to confirm it passes**

```bash
make build-app && docker run --rm app-app:latest node --test scripts/send-state.test.mjs
```
Expected: PASS (3 tests).

- [ ] **Step 6: Confirm the email path is unbroken**

```bash
docker run --rm app-app:latest node -e "import('./scripts/send-state.mjs').then(m=>console.log(m.MAX_SENDS_PER_DAY, typeof m.loadSendState, typeof m.recordSend, m.DISCORD_MAX_SENDS_PER_DAY))"
```
Expected: `500 function function 1000` (with default env).

- [ ] **Step 7: Commit**

```bash
git add app/scripts/paths.mjs app/scripts/send-state.mjs app/scripts/send-state.test.mjs
git commit -m "Add a separate Discord daily send-cap counter"
```

---

## Task 3: Add Discord memory paths

**Files:**
- Modify: `app/scripts/paths.mjs`

**Interfaces:**
- Produces: `MEMORY_DIR` (the shared run cwd), `discordChannelMemoryPath(channelId)` → absolute path string.

- [ ] **Step 1: Add the exports**

In `app/scripts/paths.mjs`, after the `MEMORY_PATH` export add:

```js
// The directory MEMORY_PATH lives in -- also the cwd of every claude -p run
// (email and Discord), so it holds the shared memory.md, the run's
// .claude/skills (including ad-hoc skills the agent writes), and Discord's
// per-channel memory files below. Writes are sandbox-bounded to this dir.
export const MEMORY_DIR = dirname(MEMORY_PATH);

// Per-channel Discord memory. Lives under the run cwd so the sandbox permits
// writes; one file per channel/DM id. channelId comes from Discord and is a
// numeric snowflake string, so it's filesystem-safe as-is, but basename() it
// defensively in case a caller ever passes something odd.
export function discordChannelMemoryPath(channelId) {
  return join(MEMORY_DIR, "discord", `${basename(String(channelId))}.md`);
}
```

Add `basename` to the `node:path` import at the top: `import { join, dirname, basename } from "node:path";`

- [ ] **Step 2: Verify it loads and resolves sanely**

```bash
docker run --rm app-app:latest node -e "import('./scripts/paths.mjs').then(m=>console.log(m.MEMORY_DIR, m.discordChannelMemoryPath('12345')))"
```
Expected: prints `/home/node/.mail-agent/memory-workspace /home/node/.mail-agent/memory-workspace/discord/12345.md`.

- [ ] **Step 3: Commit**

```bash
git add app/scripts/paths.mjs
git commit -m "Add Discord per-channel memory paths"
```

---

## Task 4: discord-cli.mjs — pure helpers (TDD)

Build the token-scoped REST CLI's pure, unit-testable pieces first: message chunking (≤2000), reaction-emoji URL encoding, and CLI arg parsing.

**Files:**
- Create: `app/scripts/discord-cli.mjs`
- Create: `app/scripts/discord-cli.test.mjs`

**Interfaces:**
- Produces: `chunkMessage(text, max=2000)` → `string[]`; `encodeEmoji(emoji)` → string; `parseFlags(args)` → `{ positionals: string[], flags: Record<string,string> }`.

- [ ] **Step 1: Write the failing tests**

Create `app/scripts/discord-cli.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMessage, encodeEmoji, parseFlags } from "./discord-cli.mjs";

test("chunkMessage passes short text through as one chunk", () => {
  assert.deepEqual(chunkMessage("hello"), ["hello"]);
});
test("chunkMessage splits on newline boundaries under the cap", () => {
  const line = "x".repeat(1500);
  const out = chunkMessage(`${line}\n${line}`);
  assert.equal(out.length, 2);
  assert.ok(out.every((c) => c.length <= 2000));
});
test("chunkMessage hard-splits a single over-long line", () => {
  const out = chunkMessage("y".repeat(4500));
  assert.equal(out.length, 3);
  assert.ok(out.every((c) => c.length <= 2000));
  assert.equal(out.join(""), "y".repeat(4500));
});
test("encodeEmoji percent-encodes a unicode emoji", () => {
  assert.equal(encodeEmoji("👍"), encodeURIComponent("👍"));
});
test("encodeEmoji formats a custom emoji as name:id", () => {
  assert.equal(encodeEmoji("<:party:12345>"), "party:12345");
});
test("parseFlags separates positionals and --flags", () => {
  const { positionals, flags } = parseFlags(["chan", "msg", "--limit", "50"]);
  assert.deepEqual(positionals, ["chan", "msg"]);
  assert.deepEqual(flags, { limit: "50" });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
docker run --rm app-app:latest node --test scripts/discord-cli.test.mjs
```
Expected: FAIL — module not found / exports missing.

- [ ] **Step 3: Implement the pure helpers**

Create `app/scripts/discord-cli.mjs` with the helpers (REST actions added in Task 5):

```js
#!/usr/bin/env node
// Token-scoped Discord REST CLI. The ONLY component besides discord-bot.mjs
// that reads DISCORD_BOT_TOKEN -- the spawned claude -p run reaches Discord
// only through `Bash(discord-cli *)`, never the raw token (mirrors gmail.mjs).
// Uses raw fetch to the REST API v10; no discord.js / no gateway.
import { pathToFileURL } from "node:url";

const API = "https://discord.com/api/v10";

// Discord hard-caps one message at 2000 chars. Split on newline boundaries
// where possible; hard-slice any single line that itself exceeds the cap.
export function chunkMessage(text, max = 2000) {
  if (text.length <= max) return [text];
  const chunks = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (line.length > max) {
      if (cur) { chunks.push(cur); cur = ""; }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    const candidate = cur ? `${cur}\n${line}` : line;
    if (candidate.length > max) { chunks.push(cur); cur = line; }
    else cur = candidate;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Reaction endpoints want either a URL-encoded unicode emoji, or `name:id`
// for a custom emoji written as `<:name:id>` / `<a:name:id>`.
export function encodeEmoji(emoji) {
  const m = emoji.match(/^<a?:(\w+):(\d+)>$/);
  if (m) return `${m[1]}:${m[2]}`;
  return encodeURIComponent(emoji);
}

// Minimal flag parser: `--key value` pairs become flags; everything else is a
// positional. No `--key=value`, no booleans (none needed by this CLI).
export function parseFlags(args) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { flags[args[i].slice(2)] = args[++i]; }
    else positionals.push(args[i]);
  }
  return { positionals, flags };
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
make build-app && docker run --rm app-app:latest node --test scripts/discord-cli.test.mjs
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/scripts/discord-cli.mjs app/scripts/discord-cli.test.mjs
git commit -m "Add discord-cli pure helpers (chunk/emoji/flags) with tests"
```

---

## Task 5: discord-cli.mjs — REST actions and CLI dispatch

Add the token-authenticated REST calls and the command dispatch. This is live I/O; verified by an integration smoke test against a real test server (no unit test — it hits the network).

**Files:**
- Modify: `app/scripts/discord-cli.mjs`

**Interfaces:**
- Consumes: `chunkMessage`, `encodeEmoji`, `parseFlags` (Task 4); `DISCORD_BOT_TOKEN` env.
- Produces: CLI commands `whoami`, `send <channelId>` (stdin body), `reply <channelId> <messageId>` (stdin body), `react <channelId> <messageId> <emoji>`, `fetch-history <channelId> [--limit N] [--before ID]`, `create-thread <channelId> <name> [--messageId ID]`, `send-thread <threadId>` (stdin body), `edit <channelId> <messageId>` (stdin body), `delete-own <channelId> <messageId>`, `pin <channelId> <messageId>`, `unpin <channelId> <messageId>`, `typing <channelId>`. **No membership/role/channel-management commands exist** (defense in depth).

- [ ] **Step 1: Add a REST helper and the actions**

Append to `app/scripts/discord-cli.mjs`:

```js
function token() {
  const t = process.env.DISCORD_BOT_TOKEN;
  if (!t) throw new Error("DISCORD_BOT_TOKEN is not set");
  return t;
}

// One REST call with bot auth and one 429 retry honoring retry_after. Returns
// parsed JSON (or null for 204). Throws on non-2xx with the response body.
async function api(method, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token()}`,
        "Content-Type": "application/json",
        "User-Agent": "BaxterBurgundy (https://example.invalid, 1.0)",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const info = await res.json().catch(() => ({}));
      const waitMs = Math.ceil((info.retry_after ?? 1) * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`Discord ${method} ${path} -> ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`Discord ${method} ${path}: rate-limited twice`);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function sendMessage(channelId, content, extra = {}) {
  const parts = chunkMessage(content);
  let last = null;
  for (const part of parts) last = await api("POST", `/channels/${channelId}/messages`, { content: part, ...extra });
  return last; // id of the final message posted
}

async function fetchHistory(channelId, limit = 100, before) {
  const out = [];
  let cursor = before;
  while (out.length < limit) {
    const batch = Math.min(100, limit - out.length);
    const q = new URLSearchParams({ limit: String(batch) });
    if (cursor) q.set("before", cursor);
    const page = await api("GET", `/channels/${channelId}/messages?${q}`);
    if (!page.length) break;
    out.push(...page);
    cursor = page[page.length - 1].id; // API returns newest-first
    if (page.length < batch) break;
  }
  return out; // newest-first; caller reverses for chronological rendering
}
```

- [ ] **Step 2: Add the CLI dispatch (entry-guarded)**

Append the dispatch block:

```js
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , cmd, ...rest] = process.argv;
  const { positionals, flags } = parseFlags(rest);
  try {
    switch (cmd) {
      case "whoami":
        console.log(JSON.stringify(await api("GET", "/users/@me")));
        break;
      case "send":
        console.log(JSON.stringify(await sendMessage(positionals[0], await readStdin())));
        break;
      case "reply":
        console.log(JSON.stringify(await sendMessage(positionals[0], await readStdin(), {
          message_reference: { message_id: positionals[1] },
        })));
        break;
      case "react":
        await api("PUT", `/channels/${positionals[0]}/messages/${positionals[1]}/reactions/${encodeEmoji(positionals[2])}/@me`);
        break;
      case "fetch-history": {
        const msgs = await fetchHistory(positionals[0], Number(flags.limit ?? 100), flags.before);
        console.log(JSON.stringify(msgs.reverse())); // chronological
        break;
      }
      case "create-thread": {
        const [channelId, name] = positionals;
        const path = flags.messageId
          ? `/channels/${channelId}/messages/${flags.messageId}/threads`
          : `/channels/${channelId}/threads`;
        console.log(JSON.stringify(await api("POST", path, { name, type: 11 })));
        break;
      }
      case "send-thread":
        console.log(JSON.stringify(await sendMessage(positionals[0], await readStdin())));
        break;
      case "edit":
        await api("PATCH", `/channels/${positionals[0]}/messages/${positionals[1]}`, { content: await readStdin() });
        break;
      case "delete-own":
        await api("DELETE", `/channels/${positionals[0]}/messages/${positionals[1]}`);
        break;
      case "pin":
        await api("PUT", `/channels/${positionals[0]}/pins/${positionals[1]}`);
        break;
      case "unpin":
        await api("DELETE", `/channels/${positionals[0]}/pins/${positionals[1]}`);
        break;
      case "typing":
        await api("POST", `/channels/${positionals[0]}/typing`);
        break;
      default:
        console.error("Usage: discord-cli <whoami|send|reply|react|fetch-history|create-thread|send-thread|edit|delete-own|pin|unpin|typing> [args]");
        process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
```

- [ ] **Step 3: Re-run the pure-helper tests (regression)**

```bash
make build-app && docker run --rm app-app:latest node --test scripts/discord-cli.test.mjs
```
Expected: PASS (6 tests) — the dispatch block is guarded, so importing for tests doesn't run it.

- [ ] **Step 4: Integration smoke test (requires a test server + token)**

With `DISCORD_BOT_TOKEN` for a bot invited to a throwaway server, and a channel id `<CH>`:
```bash
docker run --rm -e DISCORD_BOT_TOKEN=... app-app:latest node scripts/discord-cli.mjs whoami
echo "hello from baxter cli" | docker run --rm -i -e DISCORD_BOT_TOKEN=... app-app:latest node scripts/discord-cli.mjs send <CH>
docker run --rm -e DISCORD_BOT_TOKEN=... app-app:latest node scripts/discord-cli.mjs fetch-history <CH> --limit 5
```
Expected: `whoami` prints the bot's user JSON; `send` posts a message (visible in the channel) and prints the new message JSON; `fetch-history` prints a JSON array including it. Confirm there is **no** command that kicks/bans/creates-channels/edits-roles.

- [ ] **Step 5: Commit**

```bash
git add app/scripts/discord-cli.mjs
git commit -m "Add discord-cli REST actions and command dispatch"
```

---

## Task 6: Response gate — structural pre-checks (TDD)

The pure decision logic: given a normalized description of an incoming message + the bot's own id + config, decide whether to (a) ignore, (b) always-respond, or (c) run the Haiku pre-filter. No discord.js here — it operates on a plain object so it's fully unit-testable.

**Files:**
- Create: `app/scripts/discord-bot.mjs`
- Create: `app/scripts/discord-bot.test.mjs`

**Interfaces:**
- Produces: `classifyMessage(msg, opts)` → `"ignore" | "respond" | "prefilter"`, where
  `msg = { authorId, authorIsBot, isDM, guildId, mentionsBot, repliesToBot }` and
  `opts = { selfId, guildAllowlist: string[]|null, triggerOnBots: boolean }`.

- [ ] **Step 1: Write the failing tests**

Create `app/scripts/discord-bot.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMessage } from "./discord-bot.mjs";

const base = { selfId: "SELF", guildAllowlist: null, triggerOnBots: false };
const msg = (o) => ({ authorId: "U1", authorIsBot: false, isDM: false, guildId: "G1", mentionsBot: false, repliesToBot: false, ...o });

test("ignores the bot's own messages", () => {
  assert.equal(classifyMessage(msg({ authorId: "SELF" }), base), "ignore");
});
test("always responds to a DM from a human", () => {
  assert.equal(classifyMessage(msg({ isDM: true, guildId: null }), base), "respond");
});
test("always responds to an @mention from a human", () => {
  assert.equal(classifyMessage(msg({ mentionsBot: true }), base), "respond");
});
test("always responds to a human reply to the bot", () => {
  assert.equal(classifyMessage(msg({ repliesToBot: true }), base), "respond");
});
test("plain human channel message goes to the pre-filter", () => {
  assert.equal(classifyMessage(msg({}), base), "prefilter");
});
test("bot @mention wakes the pre-filter, never a reflexive respond", () => {
  // Baxter never posts reflexively at a bot; a mention only wakes the
  // (task-oriented) pre-filter, which handleChannel runs with the strict rule.
  assert.equal(classifyMessage(msg({ authorIsBot: true, mentionsBot: true }), base), "prefilter");
});
test("bot reply to the bot does NOT trigger (no ping-pong)", () => {
  assert.equal(classifyMessage(msg({ authorIsBot: true, repliesToBot: true }), base), "ignore");
});
test("plain bot message is ignored unless triggerOnBots", () => {
  assert.equal(classifyMessage(msg({ authorIsBot: true }), base), "ignore");
  assert.equal(classifyMessage(msg({ authorIsBot: true }), { ...base, triggerOnBots: true }), "prefilter");
});
test("guild not on the allowlist is ignored", () => {
  assert.equal(classifyMessage(msg({ guildId: "GX" }), { ...base, guildAllowlist: ["G1"] }), "ignore");
  assert.equal(classifyMessage(msg({ guildId: "G1" }), { ...base, guildAllowlist: ["G1"] }), "prefilter");
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
docker run --rm app-app:latest node --test scripts/discord-bot.test.mjs
```
Expected: FAIL — `classifyMessage` not defined.

- [ ] **Step 3: Implement classifyMessage**

Create `app/scripts/discord-bot.mjs` (gateway wiring comes in Task 8; this file starts with the pure function + guarded entry):

```js
#!/usr/bin/env node
// Discord gateway daemon. Holds the persistent websocket, decides whether each
// message warrants a response, and spawns a scoped `claude -p` run per trigger
// (mirroring poll.mjs for email). Reads DISCORD_BOT_TOKEN; the spawned run does
// not -- it reaches Discord only via Bash(discord-cli *).
import { pathToFileURL } from "node:url";

// Pure trigger decision. Returns "ignore" | "respond" (always-respond,
// skip the pre-filter) | "prefilter" (ask the Haiku gate). See the spec's
// "Trigger & the should-I-respond gate" section for the rules.
export function classifyMessage(msg, opts) {
  if (msg.authorId === opts.selfId) return "ignore"; // loop prevention
  if (opts.guildAllowlist && msg.guildId && !opts.guildAllowlist.includes(msg.guildId)) return "ignore";

  if (msg.authorIsBot) {
    // Baxter never posts reflexively at a bot. A bot @mention wakes the
    // pre-filter (handleChannel runs it with the strict, task-oriented rule --
    // a fired reminder passes, a reminder-set ack does not), never the
    // always-respond short-circuit. A bot's *reply* to us, or a plain bot
    // message, is context-only unless triggerOnBots -- our original run already
    // reads bot replies via fetch-history, and triggering would re-open
    // bot-to-bot ping-pong.
    if (msg.mentionsBot) return "prefilter";
    return opts.triggerOnBots ? "prefilter" : "ignore";
  }

  // From a human: DM / mention / reply-to-us all short-circuit.
  if (msg.isDM || msg.mentionsBot || msg.repliesToBot) return "respond";
  return "prefilter";
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
make build-app && docker run --rm app-app:latest node --test scripts/discord-bot.test.mjs
```
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add app/scripts/discord-bot.mjs app/scripts/discord-bot.test.mjs
git commit -m "Add Discord response-gate structural pre-checks with tests"
```

---

## Task 7: Per-channel debounce + serialized queue (TDD)

Coalesce rapid messages per channel into one run, serialize runs per channel, and cap global concurrency. Written as a small class with an injected `runFn` and `now`/`schedule` seams so it's testable without real timers.

**Files:**
- Modify: `app/scripts/discord-bot.mjs`
- Modify: `app/scripts/discord-bot.test.mjs`

**Interfaces:**
- Produces: `class ChannelDispatcher({ debounceMs, maxConcurrent, runFn })` with `.notify(channelId, message)` and internal coalescing. `runFn(channelId, latestMessage)` returns a Promise. Exposes `.pending` / `.active` counts for tests.

- [ ] **Step 1: Write the failing tests**

Add to `app/scripts/discord-bot.test.mjs`:

```js
import { ChannelDispatcher } from "./discord-bot.mjs";

test("coalesces rapid messages in one channel into a single run", async () => {
  const calls = [];
  const d = new ChannelDispatcher({ debounceMs: 10, maxConcurrent: 5, runFn: async (ch, m) => { calls.push([ch, m.id]); } });
  d.notify("C1", { id: "m1" });
  d.notify("C1", { id: "m2" });
  d.notify("C1", { id: "m3" });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(calls, [["C1", "m3"]]); // one run, latest message
});

test("runs different channels independently", async () => {
  const calls = [];
  const d = new ChannelDispatcher({ debounceMs: 10, maxConcurrent: 5, runFn: async (ch) => { calls.push(ch); } });
  d.notify("C1", { id: "a" });
  d.notify("C2", { id: "b" });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(calls.sort(), ["C1", "C2"]);
});

test("serializes a second message that arrives while a channel run is active", async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  let first = true;
  const d = new ChannelDispatcher({ debounceMs: 5, maxConcurrent: 5, runFn: async (ch, m) => {
    order.push(`start:${m.id}`);
    if (first) { first = false; await gate; }
    order.push(`end:${m.id}`);
  }});
  d.notify("C1", { id: "m1" });
  await new Promise((r) => setTimeout(r, 20)); // m1 running, awaiting gate
  d.notify("C1", { id: "m2" });
  await new Promise((r) => setTimeout(r, 20));
  release();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, ["start:m1", "end:m1", "start:m2", "end:m2"]);
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
docker run --rm app-app:latest node --test scripts/discord-bot.test.mjs
```
Expected: FAIL — `ChannelDispatcher` not exported.

- [ ] **Step 3: Implement ChannelDispatcher**

Add to `app/scripts/discord-bot.mjs` (before the entry guard):

```js
// Coalesces rapid messages per channel (debounce), serializes runs within a
// channel (no talking over itself), and caps global concurrency. runFn does
// the actual pre-filter+run work for a channel's latest message.
export class ChannelDispatcher {
  constructor({ debounceMs, maxConcurrent, runFn }) {
    this.debounceMs = debounceMs;
    this.maxConcurrent = maxConcurrent;
    this.runFn = runFn;
    this.timers = new Map();   // channelId -> debounce timer
    this.latest = new Map();   // channelId -> latest message during debounce
    this.busy = new Set();     // channelIds with an active run
    this.queued = new Map();   // channelId -> latest message queued behind an active run
    this.active = 0;           // global active runs
    this.waiting = [];         // channelIds waiting on the global cap
  }

  notify(channelId, message) {
    this.latest.set(channelId, message);
    clearTimeout(this.timers.get(channelId));
    this.timers.set(channelId, setTimeout(() => {
      this.timers.delete(channelId);
      const msg = this.latest.get(channelId);
      this.latest.delete(channelId);
      this._enqueue(channelId, msg);
    }, this.debounceMs));
  }

  _enqueue(channelId, message) {
    if (this.busy.has(channelId)) { this.queued.set(channelId, message); return; }
    if (this.active >= this.maxConcurrent) { this.waiting.push([channelId, message]); return; }
    this._start(channelId, message);
  }

  _start(channelId, message) {
    this.busy.add(channelId);
    this.active++;
    Promise.resolve()
      .then(() => this.runFn(channelId, message))
      .catch(() => {})
      .finally(() => {
        this.busy.delete(channelId);
        this.active--;
        const q = this.queued.get(channelId);
        if (q !== undefined) { this.queued.delete(channelId); this._enqueue(channelId, q); }
        const next = this.waiting.shift();
        if (next) this._enqueue(next[0], next[1]);
      });
  }
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
make build-app && docker run --rm app-app:latest node --test scripts/discord-bot.test.mjs
```
Expected: PASS (all response-gate + dispatcher tests).

- [ ] **Step 5: Commit**

```bash
git add app/scripts/discord-bot.mjs app/scripts/discord-bot.test.mjs
git commit -m "Add per-channel debounce + serialized run queue with tests"
```

---

## Task 8: discord-bot.mjs — gateway wiring, pre-filter, run dispatch, prompt

Wire discord.js to the pure logic: build the message descriptor, render history, run the Haiku pre-filter, and dispatch the full run via `runtime.runClaude`. Also create the prompt template.

**Files:**
- Modify: `app/scripts/discord-bot.mjs`
- Create: `app/discord-prompt.md`

**Interfaces:**
- Consumes: `classifyMessage`, `ChannelDispatcher` (this file); `runClaude`, `ensureSkills`, `log`, `logErr`, `sh` (`runtime.mjs`); `normalizeLineTerminators`, `neutralizeStructuralMarkers` (`gmail.mjs`); `MEMORY_DIR`, `discordChannelMemoryPath` (`paths.mjs`); `DISCORD_MAX_SENDS_PER_DAY`, `loadDiscordSendState` (`send-state.mjs`).
- Produces: `renderHistory(messages, selfId)` → sanitized transcript string; `runPreFilter(historyTail)` → `Promise<boolean>`; the `main()` daemon.

- [ ] **Step 1: Create the prompt template**

Create `app/discord-prompt.md`:

```markdown
You are {{PERSONA_NAME}}, a member of a Discord server, operating as the bot user {{BOT_USER}}. Nobody is watching this session interactively -- read the channel below, decide what (if anything) to say or do, act, then exit. Do not ask for confirmation; make reasonable judgment calls.

You are running in an isolated container. Act freely and directly. You can do anything on this server EXCEPT manage membership -- you cannot add/remove people, change roles, or create/delete channels (those actions aren't available to you), and you should not try to route around that.

## Where this is happening

- Channel id: {{CHANNEL_ID}} ({{CHANNEL_KIND}})
- The message that triggered you (respond in this channel): from {{TRIGGER_AUTHOR}}
- Your own bot user id is {{SELF_ID}} -- never reply to or act on your own messages.

## Recent channel history (oldest first)

{{HISTORY}}

## Your memory

Two files, read BOTH first:
- Shared memory at {{MEMORY_PATH}} -- cross-cutting facts, accounts, standing preferences (shared with your email side).
- This channel's memory at {{CHANNEL_MEMORY_PATH}} -- what you've done and learned in THIS channel. Be liberal about writing notes here: decisions you made, tasks you took on, who's who, running jokes, what a given bot in this server is for and how you drove it. Write it so a future you with no memory of this conversation can pick up where you left off. Update in place; keep it organized.

## What you can do

- Act on Discord with `discord-cli` (see the discord skill): `send`, `reply`, `react`, `fetch-history` (pull more than shown above), `create-thread`, `edit`/`delete-own` (your own messages only), `pin`, `typing`. Reply to the triggering message with `discord-cli reply {{CHANNEL_ID}} {{TRIGGER_MESSAGE_ID}}` (body on stdin).
- Lean on bots already in this server rather than doing everything yourself: to schedule a reminder, ask a reminder bot; etc. When you work out how to drive a new bot/integration, WRITE YOURSELF A SKILL under `.claude/skills/<name>/SKILL.md` so you can reuse it next time -- these persist across runs.
- Browse the web via `playwright-cli` (or `invisible-cli` for bot-walled sites) -- e.g. to read a bot's docs.

Decide whether a response is even warranted. If nothing needs saying, it's fine to just update memory (or do nothing) and exit without posting.
```

- [ ] **Step 2: Implement the wiring**

Add imports at the top of `app/scripts/discord-bot.mjs` and the wiring functions + `main()`. (discord.js `Message` gives `message.mentions.has`, `message.channel.isDMBased()`, `message.reference`.)

```js
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { log, logErr, runClaude, ensureSkills } from "./runtime.mjs";
import { normalizeLineTerminators, neutralizeStructuralMarkers } from "./gmail.mjs";
import { MEMORY_DIR, discordChannelMemoryPath } from "./paths.mjs";
import { DISCORD_MAX_SENDS_PER_DAY, loadDiscordSendState } from "./send-state.mjs";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DISCORD_CLI_PATH = join(APP_DIR, "scripts", "discord-cli.mjs");
const PROMPT_PATH = join(APP_DIR, "discord-prompt.md");
const RUNS_DIR = join(APP_DIR, ".claude", "discord-runs");
const CWD_SKILLS_DIR = join(MEMORY_DIR, ".claude", "skills");
const SKILL_SRCS = [
  join(APP_DIR, ".claude", "skills", "playwright-cli"),
  join(APP_DIR, "skills", "invisible-playwright"),
  join(APP_DIR, "skills", "discord"),
];

const PERSONA_NAME = process.env.PERSONA_NAME || "Baxter Burgundy";
const MODEL = process.env.BAXTER_MODEL || "sonnet";
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const HISTORY_LIMIT = Number(process.env.DISCORD_HISTORY_LIMIT || 200);
const PREFILTER_HISTORY = Number(process.env.DISCORD_PREFILTER_HISTORY || 30);
const DEBOUNCE_MS = Number(process.env.DISCORD_DEBOUNCE_MS || 4000);
const MAX_CONCURRENT = Number(process.env.DISCORD_MAX_CONCURRENT_RUNS || 5);
const TRIGGER_ON_BOTS = /^true$/i.test(process.env.DISCORD_TRIGGER_ON_BOTS || "");
const GUILD_ALLOWLIST = (process.env.DISCORD_GUILD_ALLOWLIST || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Render fetched messages into a sanitized, oldest-first transcript. Every
// author name and body is attacker-influenced, so it goes through the same
// neutralization the email transcript uses before entering the prompt.
export function renderHistory(messages, selfId) {
  const clean = (s) => neutralizeStructuralMarkers(normalizeLineTerminators(String(s ?? "")));
  return messages.map((m) => {
    const who = m.author?.id === selfId ? `${PERSONA_NAME} (you)` : clean(m.author?.username || m.author?.id || "unknown");
    const when = m.timestamp ? new Date(m.timestamp).toISOString() : "";
    return `[${when}] ${who} (msg ${m.id}): ${clean(m.content)}`;
  }).join("\n");
}

// Cheap yes/no gate. Two framings by sender type (fromBot): a human message
// asks "is it natural to chime in?"; a bot message asks the stricter task rule
// so a reminder *firing* passes while a reminder-set *ack* does not -- Baxter
// never posts reflexively at a bot. Failing OPEN is the wrong error (spams), so
// parse strictly and default to NO on any doubt.
async function runPreFilter(historyTail, { fromBot } = {}) {
  const question = fromBot
    ? `The latest message is from another BOT. Answer YES only if that bot is helping ${PERSONA_NAME} complete a task for someone in the server, or hands him something actionable to do (e.g. a reminder he set now firing). A bare acknowledgement, confirmation, or status message is NO.`
    : `Answer YES only if it would be natural and useful for ${PERSONA_NAME} to chime in on the latest message.`;
  const prompt = `You are a filter for ${PERSONA_NAME}, a Discord member. Reply with exactly YES or NO and nothing else.\n\nRecent messages (oldest first):\n${historyTail}\n\n${question}`;
  try {
    const out = await new Promise((resolve, reject) => {
      const { spawn } = require("node:child_process"); // or import at top
      const child = spawn("claude", ["-p", "--model", "haiku"], { stdio: ["pipe", "pipe", "pipe"] });
      let o = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (d) => (o += d));
      child.on("error", reject);
      child.on("close", () => resolve(o));
      child.stdin.end(prompt);
    });
    return /\bYES\b/i.test(out) && !/\bNO\b/i.test(out);
  } catch (err) {
    logErr(`pre-filter failed, defaulting to no-respond: ${err.message}`);
    return false;
  }
}
```

> Note: replace the inline `require` with a top-of-file `import { spawn } from "node:child_process";` — shown inline here only to keep the snippet self-contained. Use the ESM import.

- [ ] **Step 3: Implement the per-channel run function and main()**

```js
function renderPrompt({ triggerMsg, history, selfId, channelId, channelKind }) {
  const template = readFileSync(PROMPT_PATH, "utf8");
  const clean = (s) => neutralizeStructuralMarkers(normalizeLineTerminators(String(s ?? "")));
  return template
    .replaceAll("{{PERSONA_NAME}}", PERSONA_NAME)
    .replaceAll("{{BOT_USER}}", PERSONA_NAME)
    .replaceAll("{{CHANNEL_ID}}", channelId)
    .replaceAll("{{CHANNEL_KIND}}", channelKind)
    .replaceAll("{{SELF_ID}}", selfId)
    .replaceAll("{{TRIGGER_AUTHOR}}", clean(triggerMsg.author?.username || "unknown"))
    .replaceAll("{{TRIGGER_MESSAGE_ID}}", triggerMsg.id)
    .replaceAll("{{HISTORY}}", renderHistory(history, selfId))
    .replaceAll("{{MEMORY_PATH}}", join(MEMORY_DIR, "memory.md"))
    .replaceAll("{{CHANNEL_MEMORY_PATH}}", discordChannelMemoryPath(channelId));
}

// Called by ChannelDispatcher for a channel's latest message. Fetches history,
// applies the pre-filter for "prefilter"-class messages, and spawns the run.
async function handleChannel(client, channelId, message, decision) {
  const selfId = client.user.id;
  const raw = await client.rest.get(`/channels/${channelId}/messages?limit=${Math.min(100, HISTORY_LIMIT)}`);
  const history = raw.reverse(); // chronological
  if (decision === "prefilter") {
    const tail = renderHistory(history.slice(-PREFILTER_HISTORY), selfId);
    // Strict, task-oriented framing when the triggering message is a bot's.
    if (!(await runPreFilter(tail, { fromBot: message.author?.bot }))) {
      log(`[${channelId}] pre-filter: no response`);
      return;
    }
  }
  const allowedTools = `Bash(node ${DISCORD_CLI_PATH} *) Bash(discord-cli *) Bash(playwright-cli *) Bash(invisible-cli *) Skill Read Write Edit`;
  const { outOfTokens } = await runClaude({
    prompt: renderPrompt({ triggerMsg: message, history, selfId, channelId, channelKind: message.guildId ? "guild channel" : "DM" }),
    logId: message.id,
    cwd: MEMORY_DIR,
    model: MODEL,
    allowedTools,
    runsDir: RUNS_DIR,
    beforeRun: () => ensureSkills(SKILL_SRCS, CWD_SKILLS_DIR),
  });
  if (outOfTokens) {
    try { await client.rest.post(`/channels/${channelId}/messages`, { body: { content: `${PERSONA_NAME} is out of tokens right now and couldn't get to this -- ping me again later.` } }); }
    catch (err) { logErr(`[${channelId}] out-of-tokens notice failed: ${err.message}`); }
  }
}

async function main() {
  if (!TOKEN) { logErr("DISCORD_BOT_TOKEN is not set; Discord bot disabled."); process.exit(0); }
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });
  const dispatcher = new ChannelDispatcher({
    debounceMs: DEBOUNCE_MS,
    maxConcurrent: MAX_CONCURRENT,
    runFn: (channelId, m) => handleChannel(client, channelId, m.message, m.decision).catch((e) => logErr(`[${channelId}] run failed: ${e.message}`)),
  });

  client.once(Events.ClientReady, (c) => {
    const { count } = loadDiscordSendState();
    log(`Discord bot ready as ${c.user.tag} (${c.user.id}); model ${MODEL}; ${count}/${DISCORD_MAX_SENDS_PER_DAY} sends used today.`);
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      const selfId = client.user.id;
      let repliesToBot = false;
      if (message.reference?.messageId) {
        const ref = await message.fetchReference().catch(() => null);
        repliesToBot = ref?.author?.id === selfId;
      }
      const descriptor = {
        authorId: message.author.id,
        authorIsBot: message.author.bot,
        isDM: message.channel.isDMBased(),
        guildId: message.guildId ?? null,
        mentionsBot: message.mentions.has(selfId),
        repliesToBot,
      };
      const decision = classifyMessage(descriptor, { selfId, guildAllowlist: GUILD_ALLOWLIST.length ? GUILD_ALLOWLIST : null, triggerOnBots: TRIGGER_ON_BOTS });
      if (decision === "ignore") return;
      dispatcher.notify(message.channelId, { id: message.id, message, decision });
    } catch (err) {
      logErr(`messageCreate handler error: ${err.message}`);
    }
  });

  await client.login(TOKEN);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
```

- [ ] **Step 4: Add a unit test for renderHistory sanitization**

Add to `app/scripts/discord-bot.test.mjs`:

```js
import { renderHistory } from "./discord-bot.mjs";

test("renderHistory labels the bot's own messages and includes ids", () => {
  const out = renderHistory([
    { id: "1", author: { id: "SELF", username: "baxter" }, content: "hi", timestamp: 0 },
    { id: "2", author: { id: "U1", username: "erik" }, content: "hey", timestamp: 0 },
  ], "SELF");
  assert.match(out, /\(you\).*msg 1/s);
  assert.match(out, /erik.*msg 2/s);
});
```

(`renderHistory` imports `gmail.mjs`, so this test only runs in the image, not the dev container.)

- [ ] **Step 5: Run tests + a no-token smoke test**

```bash
make build-app
docker run --rm app-app:latest node --test scripts/discord-bot.test.mjs
docker run --rm --entrypoint node app-app:latest scripts/discord-bot.mjs 2>&1 | head -1
```
Expected: tests PASS; the no-token run prints `DISCORD_BOT_TOKEN is not set; Discord bot disabled.` and exits 0.

- [ ] **Step 6: Commit**

```bash
git add app/scripts/discord-bot.mjs app/discord-prompt.md app/scripts/discord-bot.test.mjs
git commit -m "Wire Discord gateway: pre-filter, prompt, and run dispatch"
```

---

## Task 9: The `discord` skill

**Files:**
- Create: `app/skills/discord/SKILL.md`

**Interfaces:**
- Consumes: `discord-cli` (Task 5). Copied into the run cwd by `ensureSkills(SKILL_SRCS, ...)` (Task 8's `SKILL_SRCS`).

- [ ] **Step 1: Write the skill**

Create `app/skills/discord/SKILL.md`, following the shape of `app/skills/invisible-playwright/SKILL.md` (read it first for the frontmatter format). Include YAML frontmatter with `name: discord`, a one-line `description`, and `allowed-tools: Bash(discord-cli:*)`. Body must document: the full `discord-cli` command surface from Task 5 (each command, its args, stdin-vs-flag inputs, output shape); that only Baxter's *own* messages can be edited/deleted; Discord conventions (2000-char limit is auto-chunked, mentions as `<@id>`, custom emoji as `<:name:id>`, threads); the per-channel + shared memory workflow; and the ad-hoc-skill workflow (write `.claude/skills/<name>/SKILL.md` to remember how to drive a new bot). State plainly that membership/role/channel-management actions are intentionally unavailable.

- [ ] **Step 2: Verify frontmatter parses**

Read the file back and confirm the frontmatter matches the invisible-playwright skill's structure (same keys, valid YAML).

- [ ] **Step 3: Commit**

```bash
git add app/skills/discord/SKILL.md
git commit -m "Add the discord skill documenting discord-cli"
```

---

## Task 10: Deployment wiring — Makefile, env, install path, docs

**Files:**
- Modify: `Makefile`
- Modify: `app/.env.example`
- Modify: `app/Dockerfile`
- Modify: `app/CLAUDE.md`

**Interfaces:**
- Produces: `make discord` target; documented env; `discord-cli` on PATH inside the image.

- [ ] **Step 1: Add the `make discord` target**

In `Makefile`, add `discord` to the `.PHONY` line and add after the `run` target:

```makefile
discord: build-app
	docker run -it --rm \
		--memory=8g --shm-size=2g \
		$(APP_ENV_FILE) \
		-v "$(APP_CONFIG_VOLUME):/home/node" \
		$(APP_IMAGE) node scripts/discord-bot.mjs
```

(Same volume + memory flags as `run`; different entry command. Shares the config volume so memory/skills/token are shared with the mail poller.)

- [ ] **Step 2: Install discord-cli on PATH in the image**

In `app/Dockerfile`, near where `invisible-cli` is installed, add a `discord-cli` shim so the run's `Bash(discord-cli *)` rule resolves. Add before `USER node`:

```dockerfile
RUN printf '#!/bin/sh\nexec node /app/scripts/discord-cli.mjs "$@"\n' > /usr/local/bin/discord-cli \
    && chmod +x /usr/local/bin/discord-cli
```

(Confirm the exact path style matches the existing `invisible-cli` shim in the Dockerfile; mirror it.)

- [ ] **Step 3: Add env vars to .env.example**

Append to `app/.env.example`:

```bash
# --- Discord bot (optional; unset DISCORD_BOT_TOKEN disables it) ---
# Bot token from the Discord Developer Portal (Bot tab). The Message Content
# privileged intent MUST be enabled there. Only discord-bot.mjs and
# discord-cli.mjs ever read this; the per-message claude run never sees it.
DISCORD_BOT_TOKEN=
# Daily Discord send cap (flood guard), analogous to MAX_SENDS_PER_DAY.
DISCORD_MAX_SENDS_PER_DAY=1000
# Scrollback fed to the full run's prompt (paginated past 100/request).
DISCORD_HISTORY_LIMIT=200
# Recent-tail messages fed to the cheap Haiku pre-filter (the hot path).
DISCORD_PREFILTER_HISTORY=30
# Per-channel coalescing window: rapid messages become one run.
DISCORD_DEBOUNCE_MS=4000
# Global cap on simultaneous claude runs across channels.
DISCORD_MAX_CONCURRENT_RUNS=5
# Whether a plain message from another bot can trigger a run (default no,
# anti-ping-pong). Bot @mentions of Baxter always trigger regardless.
DISCORD_TRIGGER_ON_BOTS=false
# Optional comma-separated guild-id allowlist. Empty = any invited server.
DISCORD_GUILD_ALLOWLIST=
```

- [ ] **Step 4: Document in app/CLAUDE.md**

Add a "Discord bot" section to `app/CLAUDE.md`: the process model (`make discord`, own container, shared volume), the `discord-bot.mjs`/`discord-cli.mjs`/`runtime.mjs` file roles, the response gate (structural → Haiku pre-filter → run; always-respond rules incl. the bot-mention-only nuance), per-channel + shared memory, ad-hoc skills, the "everything except membership" permission model (denied set), and the Developer Portal setup steps (create app, enable Message Content intent, token → `.env`, invite URL with the granted permissions).

- [ ] **Step 5: Build and verify the shim + target**

```bash
make build-app
docker run --rm app-app:latest sh -c 'command -v discord-cli && discord-cli 2>&1 | head -1'
```
Expected: prints the shim path and the usage line (exit 1 from no command is fine).

- [ ] **Step 6: Commit**

```bash
git add Makefile app/.env.example app/Dockerfile app/CLAUDE.md
git commit -m "Wire Discord bot: make target, env, discord-cli shim, docs"
```

---

## Task 11: End-to-end verification (manual, live server)

**Files:** none (verification only).

Requires: a Discord test server, the bot created + Message Content intent enabled + invited with the granted permissions, `DISCORD_BOT_TOKEN` in `app/.env`, and valid Gmail/subscription auth so `claude -p` runs.

- [ ] **Step 1: Start the bot**

Run: `make discord`
Expected: `Discord bot ready as <tag>` with today's send count.

- [ ] **Step 2: @mention → reply**

In a channel the bot can see, post `@Baxter what's 2+2?`.
Expected: a run fires (visible in the daemon's stdout action trace), Baxter replies in-thread.

- [ ] **Step 3: DM → reply**

DM the bot.
Expected: always responds.

- [ ] **Step 4: Natural-chime pre-filter**

Post an on-topic message that invites input (no mention), then some off-topic small talk.
Expected: the pre-filter lets the first through (Baxter chimes in) and holds the small talk (no run, `pre-filter: no response` logged).

- [ ] **Step 5: Per-channel memory + ad-hoc skill persistence**

Ask Baxter to remember something channel-specific; confirm `~/.mail-agent/discord/<channelId>.md` is written (via `make app-shell` → read the file). Ask him to learn/drive a simple server bot and confirm a new skill dir appears under `~/.mail-agent/memory-workspace/.claude/skills/` and survives a second unrelated message.

- [ ] **Step 6: Membership guardrail**

Confirm there is no `discord-cli` command to add people / manage roles / create channels, and that the bot's role in the server lacks those permissions.

- [ ] **Step 7: Burst / loop safety**

Post several messages quickly in one channel.
Expected: they coalesce into one run (debounce); Baxter never triggers on his own messages; the daily send cap is respected.

- [ ] **Step 8: Email agent unaffected**

Run: `make run` (separately) and confirm the mail poller still starts and processes email normally after the runtime.mjs refactor.

---

## Self-Review

**Spec coverage:**
- Process model (own daemon, same image, `make discord`, shared volume) → Tasks 8, 10. ✓
- Credential boundary (`discord-cli` REST, run never sees token) → Tasks 4, 5, 8. ✓
- Trigger gate (structural → Haiku pre-filter → run; human-only always-respond; bot messages never reflexive — @mention wakes the task-oriented pre-filter, reply/plain gated by TRIGGER_ON_BOTS; guild allowlist) → Tasks 6 (classify) + 8 (bot-aware pre-filter framing). ✓
- Debounce/serialize/concurrency cap → Task 7. ✓
- Send cap (separate counter) → Task 2. ✓
- Context: history (200, paginated), pre-filter tail (30), sanitization → Tasks 5, 8. ✓
- Memory: per-channel + shared → Tasks 3, 8 (prompt). ✓
- Ad-hoc skills (persist, prompt guidance) → Tasks 8 (prompt), 9 (skill). ✓
- `discord` skill + playwright skills carried along → Tasks 8, 9. ✓
- Permissions denied (CLI omits them + doc) → Tasks 5, 10. ✓
- Intents/partials → Task 8. ✓
- Bot setup walkthrough → Task 10 (CLAUDE.md + .env.example). ✓
- Testing (unit for pure logic; integration/e2e for I/O) → Tasks 1,2,4,6,7 (unit); 5,11 (integration/e2e). ✓
- Email agent unchanged → Task 1 (refactor is behavior-preserving), Task 11 Step 8. ✓

**Placeholder scan:** the `require("node:child_process")` inside `runPreFilter` is flagged inline as "replace with the top-of-file ESM import" — the implementer must use `import { spawn } from "node:child_process";`. No other placeholders.

**Type consistency:** `classifyMessage(msg, opts)` descriptor fields (`authorId`, `authorIsBot`, `isDM`, `guildId`, `mentionsBot`, `repliesToBot`) match between Task 6's definition/tests and Task 8's construction. `runClaude({...})` param names match Task 1's definition and the Task 8 call. `ChannelDispatcher` `runFn(channelId, message)` — Task 8 passes `{ id, message, decision }` as the "message"; `handleChannel` reads `m.message`/`m.decision` accordingly (consistent). Send-state exports (`loadDiscordSendState`, `DISCORD_MAX_SENDS_PER_DAY`) match between Tasks 2 and 8.

**Scope:** one cohesive feature (Discord presence) building on the existing agent; a single plan is appropriate. The runtime.mjs refactor (Task 1) is a prerequisite kept minimal and behavior-preserving.
