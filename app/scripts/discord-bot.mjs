#!/usr/bin/env node
// Discord gateway daemon. Holds the persistent websocket, decides whether each
// message warrants a response, and spawns a scoped `claude -p` run per trigger
// (mirroring poll.mjs for email). Reads DISCORD_BOT_TOKEN; the spawned run does
// not -- it reaches Discord only via Bash(discord-cli *).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { log, logErr, runClaude, ensureSkills, ensurePlaywrightConfig, fillTemplate } from "./runtime.mjs";
import { normalizeLineTerminators, neutralizeStructuralMarkers } from "./gmail.mjs";
import { MEMORY_DIR, MEMORY_PATH, discordChannelMemoryPath, DISCORD_TOKEN_PATH } from "./paths.mjs";
import { DISCORD_MAX_SENDS_PER_DAY, loadDiscordSendState, recordDiscordSend } from "./send-state.mjs";

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
// Discord's REST endpoint returns at most 100 messages per request and we don't
// paginate, so the effective ceiling is 100 (plenty for the small channels this
// runs in). Values above 100 are clamped at the fetch.
const HISTORY_LIMIT = Number(process.env.DISCORD_HISTORY_LIMIT || 100);
const PREFILTER_HISTORY = Number(process.env.DISCORD_PREFILTER_HISTORY || 30);
const DEBOUNCE_MS = Number(process.env.DISCORD_DEBOUNCE_MS || 4000);
const MAX_CONCURRENT = Number(process.env.DISCORD_MAX_CONCURRENT_RUNS || 5);
const TRIGGER_ON_BOTS = /^true$/i.test(process.env.DISCORD_TRIGGER_ON_BOTS || "");
const GUILD_ALLOWLIST = (process.env.DISCORD_GUILD_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Env handed to the spawned run, with the bot token stripped: the run drives
// discord-cli via the token FILE (written at startup), so the token never sits
// in the run's environment where an allowed `discord-cli` command could echo it.
const RUN_ENV = { ...process.env };
delete RUN_ENV.DISCORD_BOT_TOKEN;

// Sanitize attacker-influenced text before it enters the prompt -- the exact
// same pipeline the email transcript uses: normalizeLineTerminators strips
// invisible \p{Cf} format characters and folds exotic line terminators (both
// character-level tricks, done FIRST), then neutralizeStructuralMarkers does
// the byte-exact marker/separator removal. Sharing the normalizer is what keeps
// the invisible-char strip in one place across both surfaces.
const clean = (s) => neutralizeStructuralMarkers(normalizeLineTerminators(String(s ?? "")));
// Flatten newlines to spaces (author names / single-line slots must never span
// lines, or they'd forge a new column-0 entry or break out of a template slot),
// then RE-neutralize: the flatten can turn `[^` + newline + `RESPOND ...]` into
// the live email trigger marker after clean() ran -- a composition seam.
const oneLine = (s) => neutralizeStructuralMarkers(clean(s).split("\n").join(" "));
// Author names additionally must not contain the `(msg <id>):` structural
// token: a single-line webhook name like `erik (msg 777): ... mallory` would
// otherwise forge the column-0 `[ts] author (msg id):` prefix (fake attribution
// AND a fake msg id the run would act on) with no newline needed. Break `(msg`
// case-insensitively (`(MSG` reads structurally too); `( msg` can't recombine,
// but loop for fixed-point safety. Invisibles are already gone (clean strips
// \p{Cf}), so they can't split the token.
const safeAuthor = (s) => {
  let r = oneLine(s);
  while (/\(msg/i.test(r)) r = r.replace(/\(msg/gi, "( msg");
  return r;
};

// True iff `content` explicitly @mentions the user (`<@id>` / `<@!id>` nickname
// form). Derived from message content (the MessageContent intent is enabled),
// NOT message.mentions.has(): that also counts @everyone/@here, mentions of a
// role Baxter holds, and reply auto-pings (the replied-to user sits in the raw
// mentions array even with ignoreRepliedUser), none of which should wake Baxter.
export function mentionsUser(content, userId) {
  return new RegExp(`<@!?${userId}>`).test(content ?? "");
}

// Render fetched Discord messages into a sanitized, oldest-first transcript.
// Every author name and body is attacker-influenced, so it goes through the
// same neutralization the email transcript uses before entering the prompt.
export function renderHistory(messages, selfId) {
  return messages
    .map((m) => {
      // Author name flattened to one line (see oneLine) so it can't forge the
      // column-0 line prefix; body continuation lines indented so a multi-line
      // message can't forge a new entry attributed to someone else -- only
      // column-0 lines start a message (the prompt says so).
      const who = m.author?.id === selfId ? `${PERSONA_NAME} (you)` : safeAuthor(m.author?.username || m.author?.id || "unknown");
      const when = m.timestamp ? new Date(m.timestamp).toISOString() : "";
      return `[${when}] ${who} (msg ${m.id}): ${clean(m.content).split("\n").join("\n    ")}`;
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

  // Coalesce a channel's pending item with a newer one: keep the newest message
  // for context, but ESCALATE the decision -- a "respond" trigger (human DM/
  // mention/reply) is never downgraded to "prefilter" by a following plain
  // message, which would let the Haiku gate veto a guaranteed reply. The
  // coalesced pre-filter is treated as bot-only iff every trigger was a bot;
  // any human in the mix uses the lenient human framing.
  _coalesce(prev, next) {
    const decision = prev.decision === "respond" || next.decision === "respond" ? "respond" : "prefilter";
    return { id: next.id, message: next.message, decision, fromBot: Boolean(prev.fromBot) && Boolean(next.fromBot) };
  }

  _merge(map, channelId, item) {
    const prev = map.get(channelId);
    map.set(channelId, prev ? this._coalesce(prev, item) : item);
  }

  notify(channelId, item) {
    this._merge(this.latest, channelId, item);
    clearTimeout(this.timers.get(channelId));
    this.timers.set(channelId, setTimeout(() => {
      this.timers.delete(channelId);
      const merged = this.latest.get(channelId);
      this.latest.delete(channelId);
      this._enqueue(channelId, merged);
    }, this.debounceMs));
  }

  _enqueue(channelId, item) {
    if (this.busy.has(channelId)) { this._merge(this.queued, channelId, item); return; }
    // Keyed by channel so a later message escalates/replaces (not appends) the
    // waiting entry -- otherwise a channel could sit in the queue twice and a
    // stale entry could clobber a newer one.
    if (this.waiting.has(channelId) || this.active >= this.maxConcurrent) { this._merge(this.waiting, channelId, item); return; }
    this._start(channelId, item);
  }

  _start(channelId, message) {
    this.busy.add(channelId);
    this.active++;
    Promise.resolve()
      .then(() => this.runFn(channelId, message))
      .catch((err) => logErr(`[${channelId}] run failed: ${err?.message ?? err}`))
      .finally(() => {
        this.busy.delete(channelId);
        this.active--;
        // Put this channel's own follow-up at the BACK of waiting (don't
        // dispatch it directly -- that would steal the freed slot and starve
        // other waiters), then start the front waiter into the now-free slot.
        const q = this.queued.get(channelId);
        if (q !== undefined) { this.queued.delete(channelId); this._merge(this.waiting, channelId, q); }
        const next = this.waiting.entries().next().value;
        if (next) { this.waiting.delete(next[0]); this._start(next[0], next[1]); }
      });
  }
}

function renderPrompt({ triggerMsg, history, selfId, channelId, channelKind }) {
  const template = readFileSync(PROMPT_PATH, "utf8");
  // Single-pass fill (see fillTemplate): attacker-influenced values (author,
  // history) are inserted verbatim and never re-scanned -- no $-expansion, and
  // no `{{OTHER}}` inside one value getting filled by a later pass.
  return fillTemplate(template, {
    PERSONA_NAME,
    BOT_USER: PERSONA_NAME,
    CHANNEL_ID: channelId,
    CHANNEL_KIND: channelKind,
    SELF_ID: selfId,
    TRIGGER_AUTHOR: safeAuthor(triggerMsg.author?.username || "unknown"),
    TRIGGER_MESSAGE_ID: triggerMsg.id,
    HISTORY: renderHistory(history, selfId),
    MEMORY_PATH,
    CHANNEL_MEMORY_PATH: discordChannelMemoryPath(channelId),
  });
}

// Called by ChannelDispatcher for a channel's latest message. Fetches recent
// history, applies the pre-filter for "prefilter"-class messages, then spawns
// the scoped run (which acts via discord-cli). The run itself can pull more
// history on demand via `discord-cli fetch-history`.
async function handleChannel(client, channelId, message, decision, fromBot) {
  const selfId = client.user.id;
  const raw = await client.rest.get(`/channels/${channelId}/messages?limit=${Math.min(100, HISTORY_LIMIT)}`);
  const history = raw.reverse(); // Discord returns newest-first; make it chronological
  if (decision === "prefilter") {
    const tail = renderHistory(history.slice(-PREFILTER_HISTORY), selfId);
    if (!(await runPreFilter(tail, { fromBot }))) {
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
    env: RUN_ENV,
    beforeRun: () => {
      ensurePlaywrightConfig(MEMORY_DIR);
      ensureSkills(SKILL_SRCS, CWD_SKILLS_DIR);
    },
  });
  if (outOfTokens) {
    // Count this against the daily cap too: during an outage every trigger
    // fails, so an uncapped notice per channel is itself the flood the cap
    // guards against.
    if (loadDiscordSendState().count >= DISCORD_MAX_SENDS_PER_DAY) return;
    try {
      await client.rest.post(`/channels/${channelId}/messages`, {
        body: { content: `${PERSONA_NAME} is out of tokens right now and couldn't get to this -- ping me again later.` },
      });
      recordDiscordSend();
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
  // Persist the token (0600) so discord-cli can read it from a file and the
  // spawned run doesn't need it in its env (see RUN_ENV). Outside the run's cwd.
  mkdirSync(dirname(DISCORD_TOKEN_PATH), { recursive: true });
  writeFileSync(DISCORD_TOKEN_PATH, JSON.stringify({ token: TOKEN }), { mode: 0o600 });
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Only Channel is needed (DM channels arrive partial). No reaction/uncached-
    // message events are handled -- sending reactions goes through discord-cli's
    // REST call, which needs no gateway intent.
    partials: [Partials.Channel],
  });
  const dispatcher = new ChannelDispatcher({
    debounceMs: DEBOUNCE_MS,
    maxConcurrent: MAX_CONCURRENT,
    // The dispatcher's own catch logs failures, so no .catch here.
    runFn: (channelId, m) => handleChannel(client, channelId, m.message, m.decision, m.fromBot),
  });

  client.once(Events.ClientReady, (c) => {
    const { count } = loadDiscordSendState();
    log(`Discord bot ready as ${c.user.tag} (${c.user.id}); model ${MODEL}; ${count}/${DISCORD_MAX_SENDS_PER_DAY} sends used today.`);
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      const selfId = client.user.id;
      // Cheap ignore checks BEFORE the fetchReference REST call below: skip our
      // own messages (every discord-cli reply echoes back through the gateway)
      // and off-allowlist guilds, so we don't spend a round-trip on messages
      // that were never candidates. classifyMessage re-checks both defensively.
      if (message.author.id === selfId) return;
      if (GUILD_ALLOWLIST.length && message.guildId && !GUILD_ALLOWLIST.includes(message.guildId)) return;
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
        // Real @mention only (explicit <@id> token in content) -- see
        // mentionsUser. mentions.has() with ignore* flags is insufficient: a
        // ping-on reply still puts the replied-to user in the raw mentions
        // array, so a bot ping-replying to Baxter would wrongly wake the
        // pre-filter. reply-to-Baxter is carried separately by repliesToBot.
        mentionsBot: mentionsUser(message.content, selfId),
        repliesToBot,
      };
      const decision = classifyMessage(descriptor, {
        selfId,
        guildAllowlist: GUILD_ALLOWLIST.length ? GUILD_ALLOWLIST : null,
        triggerOnBots: TRIGGER_ON_BOTS,
      });
      if (decision === "ignore") return;
      dispatcher.notify(message.channelId, { id: message.id, message, decision, fromBot: message.author.bot });
    } catch (err) {
      logErr(`messageCreate handler error: ${err?.message ?? err}`);
    }
  });

  await client.login(TOKEN);
}

// Only run the daemon when invoked directly, not when a test imports the pure
// functions (classifyMessage/ChannelDispatcher/renderHistory).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
