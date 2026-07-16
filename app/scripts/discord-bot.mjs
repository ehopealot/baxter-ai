#!/usr/bin/env node
// Discord gateway daemon. Holds the persistent websocket, decides whether each
// message warrants a response, and spawns a scoped `claude -p` run per trigger
// (mirroring poll.mjs for email). Reads DISCORD_BOT_TOKEN; the spawned run does
// not -- it reaches Discord only via Bash(discord-cli *).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { log, logErr, runClaude, ensureSkills, ensurePlaywrightConfig, fillTemplate } from "./runtime.mjs";
import { normalizeTranscriptText, neutralizeStructuralMarkers } from "./gmail.mjs";
import { MEMORY_DIR, MEMORY_PATH, CREDENTIALS_PATH, LEARNED_SKILLS_DIR, discordChannelMemoryPath, DISCORD_TOKEN_PATH } from "./paths.mjs";
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
  join(APP_DIR, "skills", "code"),
  join(APP_DIR, "skills", "schedule"),
];

const PERSONA_NAME = process.env.PERSONA_NAME || "Baxter Burgundy";
const MODEL = process.env.BAXTER_MODEL || "sonnet";
const TOKEN = process.env.DISCORD_BOT_TOKEN;
// Discord's REST endpoint returns at most 100 messages per request and we don't
// paginate, so the effective ceiling is 100 (plenty for the small channels this
// runs in). Values above 100 are clamped at the fetch.
const HISTORY_LIMIT = Number(process.env.DISCORD_HISTORY_LIMIT || 100);
const DEBOUNCE_MS = Number(process.env.DISCORD_DEBOUNCE_MS || 4000);
const MAX_CONCURRENT = Number(process.env.DISCORD_MAX_CONCURRENT_RUNS || 5);
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
// same pipeline the email transcript uses: normalizeTranscriptText strips
// invisible \p{Cf} format characters and folds exotic line terminators (both
// character-level tricks, done FIRST), then neutralizeStructuralMarkers does
// the byte-exact marker/separator removal. Sharing the normalizer is what keeps
// the invisible-char strip in one place across both surfaces.
const clean = (s) => neutralizeStructuralMarkers(normalizeTranscriptText(String(s ?? "")));
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

// Pure trigger decision. Returns "ignore" | "respond" (guaranteed reply) |
// "prefilter" (a pass-through candidate). See the spec's "Trigger & the
// should-I-respond gate" section for the rules.
export function classifyMessage(msg, opts) {
  if (msg.authorId === opts.selfId) return "ignore"; // loop prevention -- never act on our own messages
  if (opts.guildAllowlist && msg.guildId && !opts.guildAllowlist.includes(msg.guildId)) return "ignore";

  // Everyone else -- humans AND other bots -- is treated the same; only our own
  // messages (gated above) are excluded. A DM / @mention / reply-to-us is a
  // guaranteed response; anything else is a pass-through candidate. ("prefilter"
  // used to route through a Haiku yes/no gate, now disabled -- see handleChannel
  // -- so it currently proceeds straight to a run, same as a human's message.)
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
  // for context, but ESCALATE the decision -- a "respond" trigger (DM / mention
  // / reply) is never downgraded to "prefilter" by a following plain message.
  _coalesce(prev, next) {
    const decision = prev.decision === "respond" || next.decision === "respond" ? "respond" : "prefilter";
    return { id: next.id, message: next.message, decision };
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
    CREDENTIALS_PATH,
    LEARNED_SKILLS_DIR,
    CHANNEL_MEMORY_PATH: discordChannelMemoryPath(channelId),
  });
}

// Called by ChannelDispatcher for a channel's latest message. Fetches recent
// history, then spawns the scoped run (which acts via discord-cli). The run
// itself can pull more history on demand via `discord-cli fetch-history`.
//
// The Haiku relevance pre-filter is DISABLED for now (per request 2026-07-16):
// every candidate message classifyMessage lets through -- human chatter and
// other bots' messages alike -- passes straight to a run, no yes/no gate. The
// dispatcher still coalesces a `decision` per message; handleChannel no longer
// consults it. To re-enable, restore runPreFilter and gate on
// `decision === "prefilter"` here (see git history for the Haiku implementation).
async function handleChannel(client, channelId, message) {
  const selfId = client.user.id;
  const raw = await client.rest.get(`/channels/${channelId}/messages?limit=${Math.min(100, HISTORY_LIMIT)}`);
  const history = raw.reverse(); // Discord returns newest-first; make it chronological
  const allowedTools = `Bash(node ${DISCORD_CLI_PATH} *) Bash(discord-cli *) Bash(schedule-cli *) Bash(code-cli *) Bash(playwright-cli *) Bash(invisible-cli *) WebSearch WebFetch Skill Read Write Edit`;
  const { outOfTokens } = await runClaude({
    prompt: renderPrompt({
      triggerMsg: message,
      history,
      selfId,
      channelId,
      // isThread() lets the prompt's thread-specific rules actually fire; the
      // optional chaining keeps the Partials.Channel DM case safe.
      channelKind: message.channel?.isThread?.() ? "thread" : message.guildId ? "guild channel" : "DM",
    }),
    logId: message.id,
    cwd: MEMORY_DIR,
    model: MODEL,
    allowedTools,
    runsDir: RUNS_DIR,
    env: RUN_ENV,
    beforeRun: () => {
      ensurePlaywrightConfig(MEMORY_DIR);
      ensureSkills(SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR);
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
    runFn: (channelId, m) => handleChannel(client, channelId, m.message),
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
        isDM: message.channel.isDMBased(),
        guildId: message.guildId ?? null,
        // Real @mention only (explicit <@id> token in content) -- see
        // mentionsUser. mentions.has() with ignore* flags is insufficient: a
        // ping-on reply still puts the replied-to user in the raw mentions
        // array, so a bot ping-replying to Baxter would wrongly count as an
        // @mention. reply-to-Baxter is carried separately by repliesToBot.
        mentionsBot: mentionsUser(message.content, selfId),
        repliesToBot,
      };
      const decision = classifyMessage(descriptor, {
        selfId,
        guildAllowlist: GUILD_ALLOWLIST.length ? GUILD_ALLOWLIST : null,
      });
      if (decision === "ignore") return;
      dispatcher.notify(message.channelId, { id: message.id, message, decision });
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
