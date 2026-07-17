#!/usr/bin/env node
// Discord gateway daemon. Holds the persistent websocket, decides whether each
// message warrants a response, and spawns a scoped `claude -p` run per trigger
// (mirroring poll.mjs for email). Reads DISCORD_BOT_TOKEN; the spawned run does
// not -- it reaches Discord only via Bash(discord-cli *).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { log, logErr, runAgent, ensureSkills, ensurePlaywrightConfig, fillTemplate, harnessLabel } from "./runtime.mjs";
import { normalizeTranscriptText, neutralizeStructuralMarkers } from "./gmail.mjs";
import { MEMORY_DIR, MEMORY_PATH, CREDENTIALS_PATH, LEARNED_SKILLS_DIR, discordChannelMemoryPath, DISCORD_TOKEN_PATH } from "./paths.mjs";
import { DISCORD_MAX_SENDS_PER_DAY, loadDiscordSendState, recordDiscordSend } from "./send-state.mjs";
import { envInt } from "./schedule-store.mjs";
import { DISCORD_TOOLS, DISCORD_SKILL_SRCS } from "./grants.mjs";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PROMPT_PATH = join(APP_DIR, "discord-prompt.md");
const REACTION_PROMPT_PATH = join(APP_DIR, "discord-reaction-prompt.md");
const RUNS_DIR = join(APP_DIR, ".claude", "discord-runs");
const CWD_SKILLS_DIR = join(MEMORY_DIR, ".claude", "skills");
// The spawned run's tool allow-list (identical for message and reaction runs) and
// its staged skills both live in grants.mjs now -- one source of truth across
// poll/discord/heartbeat (see the module header). DISCORD_SKILL_SRCS is copied
// into the run's cwd each run (see ensureSkills in runtime.mjs).

const PERSONA_NAME = process.env.PERSONA_NAME || "Baxter Burgundy";
const MODEL = process.env.BAXTER_MODEL || "sonnet";
const TOKEN = process.env.DISCORD_BOT_TOKEN;
// Discord's REST endpoint returns at most 100 messages per request and we don't
// paginate, so the effective ceiling is 100 (plenty for the small channels this
// runs in). Values above 100 are clamped at the fetch.
// envInt fails CLOSED (throws at startup) on a non-integer/negative value rather
// than silently yielding NaN -- a NaN cap makes `active >= cap` always false, so
// a typo'd concurrency knob would otherwise become UNbounded concurrency with no
// error. Unset/blank -> the default.
const HISTORY_LIMIT = envInt("DISCORD_HISTORY_LIMIT", 100);
const DEBOUNCE_MS = envInt("DISCORD_DEBOUNCE_MS", 4000);
const MAX_CONCURRENT = envInt("DISCORD_MAX_CONCURRENT_RUNS", 5);
// Reaction runs are low-priority and rare, so they get their own small cap
// rather than sharing MAX_CONCURRENT: total parallel runs are bounded by
// MAX_CONCURRENT + this, keeping the reaction path from doubling peak load.
const REACTION_MAX_CONCURRENT = envInt("DISCORD_MAX_CONCURRENT_REACTION_RUNS", 2);
// Per-channel hourly run budget: the code-enforced terminator for a third-party
// bot loop. A ping-pong between Baxter and another bot runs strictly SERIALLY
// (each reply triggers the next message only after the prior run finishes), so
// the parallelism caps above never fire on it and DISCORD_DEBOUNCE_MS only
// throttles the rate -- the daily send cap was the sole hard stop, at ~1000
// runs/day. This bounds a single channel to N runs/hour (0 = unlimited).
const MAX_RUNS_PER_CHANNEL_PER_HOUR = envInt("DISCORD_MAX_RUNS_PER_CHANNEL_PER_HOUR", 30);
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
// "prefilter" (a pass-through candidate). The rules are the inline logic below
// plus the "Response gate" note in app/CLAUDE.md; the original design spec's
// trigger section predates the 2026-07-16 gate changes and is superseded.
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

// Pure gate for a reaction event: true iff Baxter should wake a run for it.
// Only a reaction BY someone else (never our own 👀/⏳/✅ churn) ON one of our
// OWN messages, in an allowed guild, qualifies. Mirrors classifyMessage's
// self/allowlist exclusions -- the loop guard (reactorId === selfId) is what
// keeps Baxter's own status reactions from waking him.
export function shouldHandleReaction(rx, opts) {
  if (rx.reactorId === opts.selfId) return false; // our own reaction -- never self-trigger
  if (opts.guildAllowlist && rx.guildId && !opts.guildAllowlist.includes(rx.guildId)) return false;
  return rx.messageAuthorId === opts.selfId; // only reactions to our own messages
}

// Coalesces rapid messages per channel (debounce), serializes runs within a
// channel (no talking over itself), and caps global concurrency. runFn does
// the actual pre-filter+run work for a channel's latest message.
export class ChannelDispatcher {
  constructor({ debounceMs, maxConcurrent, runFn, maxRunsPerWindow = 0, windowMs = 60 * 60 * 1000 }) {
    this.debounceMs = debounceMs;
    this.maxConcurrent = maxConcurrent;
    this.runFn = runFn;
    // Per-channel rate budget: at most maxRunsPerWindow runs started per channel
    // per windowMs. 0 disables it (the default, so ReactionDispatcher and the
    // tests are unaffected unless they opt in). runStarts tracks recent start
    // timestamps per channel, pruned to the window on each check.
    this.maxRunsPerWindow = maxRunsPerWindow;
    this.windowMs = windowMs;
    this.runStarts = new Map(); // channelId -> [start timestamps within the window]
    this.timers = new Map();   // channelId -> debounce timer
    this.latest = new Map();   // channelId -> latest message during debounce
    this.busy = new Set();     // channelIds with an active run
    this.queued = new Map();   // channelId -> latest message queued behind an active run
    this.active = 0;           // global active runs
    this.waiting = new Map();  // channelId -> latest message waiting on the global cap
  }

  // True if this channel has already used its run budget for the current window.
  // Prunes expired starts as a side effect (and drops the key when empty, so the
  // map doesn't grow unbounded across many transient channels).
  _overBudget(channelId) {
    if (!this.maxRunsPerWindow) return false; // budget disabled
    const cutoff = Date.now() - this.windowMs;
    const kept = (this.runStarts.get(channelId) || []).filter((t) => t > cutoff);
    if (kept.length) this.runStarts.set(channelId, kept);
    else this.runStarts.delete(channelId);
    return kept.length >= this.maxRunsPerWindow;
  }

  _recordRun(channelId) {
    if (!this.maxRunsPerWindow) return;
    const arr = this.runStarts.get(channelId) || [];
    arr.push(Date.now());
    this.runStarts.set(channelId, arr);
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
    // Shed the trigger entirely once a channel is over its hourly budget -- the
    // loop terminator. Dropping here (rather than queuing) is what actually
    // stops a bot ping-pong: every fresh message flows through here, so a runaway
    // channel stops spawning runs while other channels are untouched.
    if (this._overBudget(channelId)) {
      logErr(`[${channelId}] per-channel run budget reached (${this.maxRunsPerWindow}/${Math.round(this.windowMs / 60000)}m); dropping trigger`);
      return;
    }
    if (this.busy.has(channelId)) { this._merge(this.queued, channelId, item); return; }
    // Keyed by channel so a later message escalates/replaces (not appends) the
    // waiting entry -- otherwise a channel could sit in the queue twice and a
    // stale entry could clobber a newer one.
    if (this.waiting.has(channelId) || this.active >= this.maxConcurrent) { this._merge(this.waiting, channelId, item); return; }
    this._start(channelId, item);
  }

  _start(channelId, message) {
    this.busy.add(channelId);
    this._recordRun(channelId); // count the start against the per-channel budget
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

// Wakes a run when someone reacts to one of Baxter's OWN messages. A separate
// INSTANCE (not folded into the message dispatcher, which coalesces per channel
// keeping only the newest message) so a reaction can never drop a real message
// trigger; a reaction run may briefly overlap a message run in the same channel,
// the same low, already-accepted per-channel memory-write window documented in
// app/CLAUDE.md. It reuses ChannelDispatcher's whole debounce -> busy/queued/
// waiting -> cap machinery verbatim (the base is key-agnostic, so it's keyed by
// messageId here), carries its OWN smaller concurrency cap -- so total parallel
// runs are message-cap PLUS reaction-cap, bounded but not shared -- and overrides
// only the coalescing to ACCUMULATE a message's reactions instead of newest-wins.
export class ReactionDispatcher extends ChannelDispatcher {
  // Override ONLY coalescing -- a burst of reactions on one message ACCUMULATES
  // (de-duped by reactor+emoji) instead of the base's newest-wins. Everything
  // else (debounce -> busy/queued/waiting -> cap, keyed here by messageId) is the
  // base's, unchanged. Non-reaction fields are identical per message, so next's
  // are kept alongside the merged reaction list.
  _coalesce(prev, next) {
    const seen = new Set(prev.reactions.map((r) => `${r.reactorId} ${r.emoji}`));
    const reactions = prev.reactions.slice();
    for (const r of next.reactions) {
      const key = `${r.reactorId} ${r.emoji}`;
      if (!seen.has(key)) { seen.add(key); reactions.push(r); }
    }
    return { ...next, reactions };
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

// Render the reaction-run prompt from a ReactionDispatcher aggregate. Reactor
// names and (custom) emoji names are attacker-influenced, so they go through the
// same sanitizers as the transcript; the reacted message is Baxter's own, but
// cleaned too for invisible-char hygiene. Single-pass fill (see fillTemplate).
function renderReactionPrompt({ agg, selfId }) {
  const template = readFileSync(REACTION_PROMPT_PATH, "utf8");
  const reactions = agg.reactions.map((r) => `- ${safeAuthor(r.reactor)} reacted ${oneLine(r.emoji)}`).join("\n");
  return fillTemplate(template, {
    PERSONA_NAME,
    BOT_USER: PERSONA_NAME,
    CHANNEL_ID: agg.channelId,
    CHANNEL_KIND: agg.channelKind,
    SELF_ID: selfId,
    REACTED_MESSAGE_ID: agg.messageId,
    // Keep every line of a multi-line message INSIDE the `> ` blockquote: clean()
    // preserves newlines, so without the `> ` prefix on continuations they'd land
    // at column 0 as top-level prompt text -- the composition-seam injection class
    // renderHistory guards against. The reacted message is Baxter's own, but its
    // content is routinely attacker-influenced at one remove (quoted user text,
    // pasted web content, "post exactly this").
    REACTED_CONTENT: clean(agg.messageContent).split("\n").join("\n> "),
    REACTIONS: reactions,
    MEMORY_PATH,
    CREDENTIALS_PATH,
    LEARNED_SKILLS_DIR,
    CHANNEL_MEMORY_PATH: discordChannelMemoryPath(agg.channelId),
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
  const { outOfTokens } = await runAgent({
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
    allowedTools: DISCORD_TOOLS,
    runsDir: RUNS_DIR,
    // A message trigger (@mention/DM/reply) expects a reply -> let the runner
    // poke the model once if it composes an answer but never sends it. NOT set
    // on the reaction run below (a reaction is bias-to-no-op; no reply expected).
    env: { ...RUN_ENV, BAXTER_EXPECT_REPLY: "1" },
    beforeRun: () => {
      ensurePlaywrightConfig(MEMORY_DIR);
      ensureSkills(DISCORD_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR);
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

// Called by ReactionDispatcher for a message that got reactions. Spawns a scoped
// run with the reaction-specific prompt so Baxter can notice and (rarely) respond.
// Unlike handleChannel we ignore the out-of-tokens result: a reaction is low
// priority, and posting an "out of tokens" notice in response to a mere reaction
// would be exactly the noise this feature is gated to avoid.
async function handleReaction(client, agg) {
  const selfId = client.user.id;
  await runAgent({
    prompt: renderReactionPrompt({ agg, selfId }),
    logId: `rx-${agg.messageId}`,
    cwd: MEMORY_DIR,
    model: MODEL,
    allowedTools: DISCORD_TOOLS,
    runsDir: RUNS_DIR,
    env: RUN_ENV,
    beforeRun: () => {
      ensurePlaywrightConfig(MEMORY_DIR);
      ensureSkills(DISCORD_SKILL_SRCS, CWD_SKILLS_DIR, LEARNED_SKILLS_DIR);
    },
  });
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
      // Reactions on Baxter's own messages wake a run (see MessageReactionAdd).
      // Both are NON-privileged, so no Developer Portal toggle is needed.
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ],
    // Channel: DM channels arrive partial. Message/Reaction/User: the bot caches
    // almost nothing, so a reaction on an un-cached message (i.e. essentially all
    // of them) would be dropped without these -- discord.js only emits
    // MessageReactionAdd for un-cached targets when the partials are enabled.
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  });
  const dispatcher = new ChannelDispatcher({
    debounceMs: DEBOUNCE_MS,
    maxConcurrent: MAX_CONCURRENT,
    // Per-channel hourly cap -- the loop terminator for a serial bot ping-pong
    // (see MAX_RUNS_PER_CHANNEL_PER_HOUR). The reaction dispatcher below is left
    // unlimited: it only fires on Baxter's own messages and is already bounded by
    // its own concurrency cap, so it isn't a self-sustaining-loop surface.
    maxRunsPerWindow: MAX_RUNS_PER_CHANNEL_PER_HOUR,
    // The dispatcher's own catch logs failures, so no .catch here.
    runFn: (channelId, m) => handleChannel(client, channelId, m.message),
  });
  // Reactions to Baxter's own messages debounce per-message (same 4s window as
  // messages), then wake a reaction-specific run under a separate, smaller cap.
  const reactionDispatcher = new ReactionDispatcher({
    debounceMs: DEBOUNCE_MS,
    maxConcurrent: REACTION_MAX_CONCURRENT,
    runFn: (_messageId, agg) => handleReaction(client, agg),
  });

  client.once(Events.ClientReady, (c) => {
    const { count } = loadDiscordSendState();
    log(`Discord bot ready as ${c.user.tag} (${c.user.id}); harness ${harnessLabel(MODEL)}; ${count}/${DISCORD_MAX_SENDS_PER_DAY} sends used today.`);
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

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      const selfId = client.user.id;
      // Cheap loop guard FIRST: Baxter's own reactions (his 👀/⏳/✅ status
      // churn) must never wake him. user.id is present even on a partial user.
      if (user.id === selfId) return;
      // Cheap allowlist check BEFORE any REST fetch (mirrors the messageCreate
      // handler's ordering): guildId is present on the partial message straight
      // from the raw gateway payload, so a reaction in an off-allowlist guild --
      // the case the allowlist exists for -- costs zero round-trips.
      const guildId = reaction.message.guildId ?? null;
      if (GUILD_ALLOWLIST.length && guildId && !GUILD_ALLOWLIST.includes(guildId)) return;
      // The reaction and/or its message may be partial (un-cached) -- fetch
      // before reading author/content. A fetch failure just drops this event.
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
      const msg = reaction.message;
      if (!shouldHandleReaction(
        { reactorId: user.id, messageAuthorId: msg.author?.id, guildId: msg.guildId ?? null },
        { selfId, guildAllowlist: GUILD_ALLOWLIST.length ? GUILD_ALLOWLIST : null },
      )) return;
      // Reactor name for the prompt; a partial user may not carry a username yet.
      let reactor = user.username;
      if (!reactor && user.partial) { try { await user.fetch(); reactor = user.username; } catch { /* fall back to id */ } }
      // emoji.name is the unicode char for a standard emoji, or the custom
      // emoji's name; either is attacker-influenced and sanitized at render.
      const emoji = reaction.emoji?.name || reaction.emoji?.toString?.() || "?";
      reactionDispatcher.notify(msg.id, {
        channelId: msg.channelId,
        messageId: msg.id,
        messageContent: msg.content ?? "",
        channelKind: msg.channel?.isThread?.() ? "thread" : msg.guildId ? "guild channel" : "DM",
        reactions: [{ reactorId: user.id, reactor: reactor || user.id, emoji }],
      });
    } catch (err) {
      logErr(`messageReactionAdd handler error: ${err?.message ?? err}`);
    }
  });

  await client.login(TOKEN);
}

// Only run the daemon when invoked directly, not when a test imports the pure
// functions (classifyMessage/ChannelDispatcher/renderHistory).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
