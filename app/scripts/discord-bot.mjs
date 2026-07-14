#!/usr/bin/env node
// Discord gateway daemon. Holds the persistent websocket, decides whether each
// message warrants a response, and spawns a scoped `claude -p` run per trigger
// (mirroring poll.mjs for email). Reads DISCORD_BOT_TOKEN; the spawned run does
// not -- it reaches Discord only via Bash(discord-cli *).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
// Skills copied into the run's cwd each run (see ensureSkills in runtime.mjs).
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
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Render fetched Discord messages into a sanitized, oldest-first transcript.
// Every author name and body is attacker-influenced, so it goes through the
// same neutralization the email transcript uses before entering the prompt.
export function renderHistory(messages, selfId) {
  const clean = (s) => neutralizeStructuralMarkers(normalizeLineTerminators(String(s ?? "")));
  return messages
    .map((m) => {
      const who = m.author?.id === selfId ? `${PERSONA_NAME} (you)` : clean(m.author?.username || m.author?.id || "unknown");
      const when = m.timestamp ? new Date(m.timestamp).toISOString() : "";
      return `[${when}] ${who} (msg ${m.id}): ${clean(m.content)}`;
    })
    .join("\n");
}

// Cheap yes/no gate (Haiku). Two framings by sender type: a human message asks
// "is it natural to chime in?"; a bot message asks the stricter task rule so a
// reminder *firing* passes while a reminder-set *ack* does not -- Baxter never
// posts reflexively at a bot. Failing OPEN is the wrong error (it spams), so
// parse strictly and default to NO on any doubt.
async function runPreFilter(historyTail, { fromBot } = {}) {
  const question = fromBot
    ? `The latest message is from another BOT. Answer YES only if that bot is helping ${PERSONA_NAME} complete a task for someone in the server, or hands him something actionable to do (e.g. a reminder he set now firing). A bare acknowledgement, confirmation, or status message is NO.`
    : `Answer YES only if it would be natural and useful for ${PERSONA_NAME} to chime in on the latest message.`;
  const prompt = `You are a filter for ${PERSONA_NAME}, a Discord member. Reply with exactly YES or NO and nothing else.\n\nRecent messages (oldest first):\n${historyTail}\n\n${question}`;
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn("claude", ["-p", "--model", "haiku"], { stdio: ["pipe", "pipe", "pipe"] });
      let o = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => (o += d));
      child.on("error", reject);
      child.on("close", () => resolve(o));
      child.stdin.on("error", () => {}); // swallow EPIPE if claude exits early (see runtime.sh)
      child.stdin.end(prompt);
    });
    return /\bYES\b/i.test(out) && !/\bNO\b/i.test(out);
  } catch (err) {
    logErr(`pre-filter failed, defaulting to no-respond: ${err.message}`);
    return false;
  }
}

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
    this.waiting = new Map();  // channelId -> latest message waiting on the global cap
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
    // Keyed by channel so a later message replaces (not appends) the waiting
    // entry -- otherwise a channel could sit in the queue twice and a stale
    // entry could clobber a newer one.
    if (this.waiting.has(channelId) || this.active >= this.maxConcurrent) { this.waiting.set(channelId, message); return; }
    this._start(channelId, message);
  }

  _start(channelId, message) {
    this.busy.add(channelId);
    this.active++;
    Promise.resolve()
      .then(() => this.runFn(channelId, message))
      .catch((err) => logErr(`[${channelId}] run failed: ${err.message}`))
      .finally(() => {
        this.busy.delete(channelId);
        this.active--;
        // Put this channel's own follow-up at the BACK of waiting (don't
        // dispatch it directly -- that would steal the freed slot and starve
        // other waiters), then start the front waiter into the now-free slot.
        const q = this.queued.get(channelId);
        if (q !== undefined) { this.queued.delete(channelId); this.waiting.set(channelId, q); }
        const next = this.waiting.entries().next().value;
        if (next) { this.waiting.delete(next[0]); this._start(next[0], next[1]); }
      });
  }
}

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

// Called by ChannelDispatcher for a channel's latest message. Fetches recent
// history, applies the pre-filter for "prefilter"-class messages, then spawns
// the scoped run (which acts via discord-cli). The run itself can pull more
// history on demand via `discord-cli fetch-history`.
async function handleChannel(client, channelId, message, decision) {
  const selfId = client.user.id;
  const raw = await client.rest.get(`/channels/${channelId}/messages?limit=${Math.min(100, HISTORY_LIMIT)}`);
  const history = raw.reverse(); // Discord returns newest-first; make it chronological
  if (decision === "prefilter") {
    const tail = renderHistory(history.slice(-PREFILTER_HISTORY), selfId);
    if (!(await runPreFilter(tail, { fromBot: message.author?.bot }))) {
      log(`[${channelId}] pre-filter: no response`);
      return;
    }
  }
  const allowedTools = `Bash(node ${DISCORD_CLI_PATH} *) Bash(discord-cli *) Bash(playwright-cli *) Bash(invisible-cli *) Skill Read Write Edit`;
  const { outOfTokens } = await runClaude({
    prompt: renderPrompt({
      triggerMsg: message,
      history,
      selfId,
      channelId,
      channelKind: message.guildId ? "guild channel" : "DM",
    }),
    logId: message.id,
    cwd: MEMORY_DIR,
    model: MODEL,
    allowedTools,
    runsDir: RUNS_DIR,
    beforeRun: () => ensureSkills(SKILL_SRCS, CWD_SKILLS_DIR),
  });
  if (outOfTokens) {
    try {
      await client.rest.post(`/channels/${channelId}/messages`, {
        body: { content: `${PERSONA_NAME} is out of tokens right now and couldn't get to this -- ping me again later.` },
      });
    } catch (err) {
      logErr(`[${channelId}] out-of-tokens notice failed: ${err.message}`);
    }
  }
}

async function main() {
  if (!TOKEN) {
    logErr("DISCORD_BOT_TOKEN is not set; Discord bot disabled.");
    process.exit(0);
  }
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
    // The dispatcher's own catch logs failures, so no .catch here.
    runFn: (channelId, m) => handleChannel(client, channelId, m.message, m.decision),
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
      const decision = classifyMessage(descriptor, {
        selfId,
        guildAllowlist: GUILD_ALLOWLIST.length ? GUILD_ALLOWLIST : null,
        triggerOnBots: TRIGGER_ON_BOTS,
      });
      if (decision === "ignore") return;
      dispatcher.notify(message.channelId, { id: message.id, message, decision });
    } catch (err) {
      logErr(`messageCreate handler error: ${err.message}`);
    }
  });

  await client.login(TOKEN);
}

// Only run the daemon when invoked directly, not when a test imports the pure
// functions (classifyMessage/ChannelDispatcher/renderHistory).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
