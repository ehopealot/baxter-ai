#!/usr/bin/env node
// Discord gateway daemon. Holds the persistent websocket, decides whether each
// message warrants a response, and spawns a scoped `claude -p` run per trigger
// (mirroring poll.mjs for email). Reads DISCORD_BOT_TOKEN; the spawned run does
// not -- it reaches Discord only via Bash(discord-cli *).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { log, logErr, runAgent, ensureSkills, ensurePlaywrightConfig, fillTemplate, harnessLabel, skillsPreamble } from "./runtime.mjs";
import { normalizeTranscriptText, neutralizeStructuralMarkers } from "./transcript.mjs";
import { MEMORY_DIR, MEMORY_PATH, CREDENTIALS_PATH, LEARNED_SKILLS_DIR, discordChannelMemoryPath, DISCORD_TOKEN_PATH } from "./paths.mjs";
import { projectsPreamble } from "./projects-cli.mjs";
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
// Recent scrollback fed into each run's prompt. Kept modest by default: most
// triggers (a mention/reply) only need recent context, and the run can pull more
// on demand via `discord-cli fetch-history`, so carrying 100 messages into every
// run was mostly wasted tokens. Must stay comfortably above the debounce coalesce
// burst (so the "catch anything that piled up" pass still sees the folded
// messages), which 25 easily does. Discord's REST endpoint returns at most 100
// per request and we don't paginate, so values above 100 are clamped at the fetch.
// envInt fails CLOSED (throws at startup) on a non-integer/negative value rather
// than silently yielding NaN -- a NaN cap makes `active >= cap` always false, so
// a typo'd concurrency knob would otherwise become UNbounded concurrency with no
// error. Unset/blank -> the default.
const HISTORY_LIMIT = envInt("DISCORD_HISTORY_LIMIT", 25);
// envInt permits 0, but Discord rejects ?limit=0 (valid range 1..100) and a
// "no history" mode doesn't exist -- reject it LOUDLY at startup rather than
// silently flooring to 1 (which would mask the misconfiguration). Same loud-guard
// idiom as heartbeat/poll's interval checks.
if (HISTORY_LIMIT === 0) throw new Error("DISCORD_HISTORY_LIMIT must be >= 1");
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
// throttles the rate -- the daily send cap was the sole hard stop. This bounds a
// single channel to N runs/hour (0 = unlimited).
const MAX_RUNS_PER_CHANNEL_PER_HOUR = envInt("DISCORD_MAX_RUNS_PER_CHANNEL_PER_HOUR", 150);
// Multimodal: when a trigger carries media AND this is set (e.g. minimax/minimax-m3),
// that run is routed to this model with the media attached (see the M3 spec). Empty
// -> feature off, every run uses the default model as before.
const MULTIMODAL_MODEL = process.env.OPENROUTER_MULTIMODAL_MODEL || "";
const MEDIA_MAX_ATTACHMENTS = envInt("DISCORD_MEDIA_MAX_ATTACHMENTS", 4);
const GUILD_ALLOWLIST = (process.env.DISCORD_GUILD_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Channels Baxter never treats as triggers -- the #baxter-logs-* log-mirror
// channels. Without this, the log webhook posts there loop: log line -> run ->
// the run's own logs -> shipped back to the channel -> another run. Scoped to
// these channel ids so webhooks + messages in ANY OTHER channel still trigger
// normally. (Comma-separated ids; resolve a log webhook's channel via a GET on
// its URL. Populated in app/.env alongside the DISCORD_LOG_WEBHOOK_* vars.)
const LOG_EXCLUDE_CHANNELS = new Set(
  (process.env.DISCORD_LOG_EXCLUDE_CHANNELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// Auto-resolve the channel each configured DISCORD_LOG_WEBHOOK* posts to (a GET on a
// webhook URL returns its channel_id), so the log-loop guard can't silently reopen
// when someone adds a log webhook but forgets DISCORD_LOG_EXCLUDE_CHANNELS. Returns
// a Set of channel ids; best-effort (a failed fetch just leans on the manual var).
// Exported + fetch-injectable for tests.
export async function resolveLogWebhookChannels(env, fetchFn = fetch) {
  // Keep the env-var KEY (a safe identifier) with each url; NEVER log the url --
  // a webhook url embeds a secret token and logErr ships the line to Discord.
  const entries = Object.keys(env)
    .filter((k) => /^DISCORD_LOG_WEBHOOK/.test(k) && /^https?:\/\//.test(env[k] || ""))
    .map((k) => [k, env[k]]);
  const ids = new Set();
  await Promise.all(
    entries.map(async ([key, url]) => {
      // Bounded: a HUNG resolve mustn't delay client.login (undici's default header
      // timeout is ~300s). Timeout aborts into the catch (the best-effort path).
      try {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
        if (!res?.ok) {
          // A PARTIAL failure would otherwise be silent (the set is non-empty from
          // the others), leaving that one log channel unguarded -> the loop reopens.
          logErr(`log-mirror: ${key} channel resolve got HTTP ${res?.status} -- its log channel is unguarded unless listed in DISCORD_LOG_EXCLUDE_CHANNELS`);
          return;
        }
        const data = await res.json();
        if (data?.channel_id) ids.add(String(data.channel_id));
      } catch (err) {
        // Redact the url from the error detail: undici's "Failed to parse URL from
        // <url>" echoes it verbatim, and logErr ships this line to a Discord channel
        // -- a webhook url embeds a secret token.
        const detail = String(err?.message ?? err).replaceAll(url, "<redacted webhook url>");
        logErr(`log-mirror: could not resolve ${key}'s channel (${detail}) -- its log channel is unguarded unless listed in DISCORD_LOG_EXCLUDE_CHANNELS`);
      }
    }),
  );
  return ids;
}

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

// A short, sanitized marker per attachment so even a TEXT-only run (which can't
// SEE media, and which multimodal routing skips when the model isn't set or the
// type doesn't forward) knows one was posted -- an image-only message otherwise
// reaches the model as an empty body. filenames are attacker-influenced, so
// oneLine them (flatten newlines + neutralize the structural markers): a marker
// stays on one line so it can NEVER forge a new column-0 transcript entry. Type
// from content_type. Raw REST message shape here (attachments = array of
// {content_type, filename}), NOT the gateway Attachment shape.
export function attachmentMarkers(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return "";
  return attachments
    .map((a) => {
      const ct = String(a?.content_type || "");
      const kind = ct.startsWith("image/") ? "image" : ct.startsWith("video/") ? "video" : ct.startsWith("audio/") ? "audio" : ct ? "file" : "attachment";
      const name = oneLine(a?.filename || "attachment") || "attachment";
      // Neutralize the COMPOSED marker, not just the filename: the template's own
      // closing `]` can complete a `[^ RESPOND TO THIS MESSAGE]` trigger marker out
      // of a partial one in the name (`foo [^ RESPOND TO THIS MESSAGE` -> `[image:
      // foo [^ RESPOND TO THIS MESSAGE]`) -- exactly the compose-AFTER-sanitize seam
      // the sanitization notes warn about. Re-neutralizing stays one line (the
      // separator pass only fires on input that already had newlines; there are none).
      return neutralizeStructuralMarkers(`[${kind}: ${name}]`);
    })
    .join(" ");
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
      // Append attachment markers (one line, no newlines) so media is visible in
      // the transcript even on a text run; both empty-body and text+media cases.
      const marks = attachmentMarkers(m.attachments);
      const body = clean(m.content);
      const text = marks ? (body ? `${body} ${marks}` : marks) : body;
      return `[${when}] ${who} (msg ${m.id}): ${text.split("\n").join("\n    ")}`;
    })
    .join("\n");
}

// Media content types forwarded to the multimodal model (image/video/audio +
// PDF). Others (zip, etc.) aren't represented, so a post carrying only those
// stays on the text model.
const isMultimodalCt = (ct) => /^(image|video|audio)\//.test(ct) || ct === "application/pdf";
// Independent copy of the runner's Discord-CDN host check (belt and suspenders,
// per the M3 spec): the daemon shouldn't import the harness module graph for a
// two-host allowlist. A message's attachment url always IS a Discord CDN url;
// validating hard-stops any future path that would inject an arbitrary one.
const isDiscordCdnUrl = (url) => {
  try {
    return url != null && ["cdn.discordapp.com", "media.discordapp.net"].includes(new URL(String(url)).hostname);
  } catch {
    return false;
  }
};

// Pull qualifying media off a gateway Message's attachment Collection, host-
// validated and capped, as [{id,url,content_type,filename,size}] (snake_case
// content_type to match the BAXTER_MEDIA wire contract the runner parses). Gateway
// Message only (`.contentType`/`.name`); the raw REST attachment shape
// (`content_type`/`filename`, array) only appears via fetch-history, which the run
// consumes itself and never routes through here. See the M3 spec.
export function selectMediaAttachments(message, { max = 4 } = {}) {
  const out = [];
  const atts = message?.attachments;
  // discord.js Collection is iterable of [key, Attachment] and exposes .values().
  const list = atts && typeof atts.values === "function" ? [...atts.values()] : Array.isArray(atts) ? atts : [];
  for (const a of list) {
    if (out.length >= max) break; // before the push, so max=0 forwards nothing
    const ct = String(a?.contentType || "");
    if (!isMultimodalCt(ct) || !isDiscordCdnUrl(a?.url)) continue;
    out.push({ id: String(a.id), url: a.url, content_type: ct, filename: a.name || "", size: a.size ?? null });
  }
  return out;
}

// Pure trigger decision. Returns "ignore" | "respond" (guaranteed reply) |
// "prefilter" (a pass-through candidate). The rules are the inline logic below
// plus the "Response gate" note in app/CLAUDE.md; the original design spec's
// trigger section predates the 2026-07-16 gate changes and is superseded.
export function classifyMessage(msg, opts) {
  if (msg.authorId === opts.selfId) return "ignore"; // loop prevention -- never act on our own messages
  // Nothing in a #baxter-logs-* mirror channel is a trigger: reacting to his own
  // shipped log lines is a self-amplifying loop. Scoped to those channels, so
  // webhooks + messages in every OTHER channel still trigger normally.
  if (msg.isLogChannel) return "ignore";
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
    // Per-CHANNEL rate budget: at most maxRunsPerWindow runs started per budget
    // key per windowMs. 0 disables it (the default, so tests are unaffected
    // unless they opt in; both production dispatchers pass
    // MAX_RUNS_PER_CHANNEL_PER_HOUR). The budget key comes from _budgetKey (the
    // dispatch key by default; ReactionDispatcher overrides it to the channelId
    // so reactions are bounded per channel, not per reacted-message). runStarts
    // tracks recent start timestamps per budget key, pruned to the window.
    this.maxRunsPerWindow = maxRunsPerWindow;
    this.windowMs = windowMs;
    this.runStarts = new Map(); // budgetKey -> [start timestamps within the window]
    this.timers = new Map();   // channelId -> debounce timer
    this.latest = new Map();   // channelId -> latest message during debounce
    this.busy = new Set();     // channelIds with an active run
    this.queued = new Map();   // channelId -> latest message queued behind an active run
    this.active = 0;           // global active runs
    this.waiting = new Map();  // channelId -> latest message waiting on the global cap
  }

  // The key a run counts against for the rate budget. Default: the dispatch key
  // (channelId for the message dispatcher). ReactionDispatcher overrides it to the
  // channelId (its dispatch key is the messageId) so reaction runs are bounded
  // per channel -- otherwise a reactor spreading across N of Baxter's old messages
  // gets N separate budgets and the aggregate is unbounded.
  _budgetKey(dispatchKey, _item) {
    return dispatchKey;
  }

  // True if this budget key has already used its run budget for the current
  // window. Sweeps the WHOLE map each call (pruning expired starts, dropping
  // now-empty keys) so it can't grow unbounded across many transient channels --
  // after the sweep the map only holds keys with a run in the last window, which
  // is small, so the full scan is cheap at this scale.
  _overBudget(budgetKey) {
    if (!this.maxRunsPerWindow) return false; // budget disabled
    const cutoff = Date.now() - this.windowMs;
    for (const [k, starts] of this.runStarts) {
      const kept = starts.filter((t) => t > cutoff);
      if (kept.length) this.runStarts.set(k, kept);
      else this.runStarts.delete(k);
    }
    return (this.runStarts.get(budgetKey)?.length ?? 0) >= this.maxRunsPerWindow;
  }

  _recordRun(budgetKey) {
    if (!this.maxRunsPerWindow) return;
    const arr = this.runStarts.get(budgetKey) || [];
    arr.push(Date.now());
    this.runStarts.set(budgetKey, arr);
  }

  // Coalesce a channel's pending item with a newer one: keep the newest message
  // for context, but ESCALATE the decision -- a "respond" trigger (DM / mention
  // / reply) is never downgraded to "prefilter" by a following plain message --
  // and CARRY FORWARD media the same way, so "post an image, then a text caption"
  // doesn't drop the image when the caption becomes the surface message. Union in
  // chronological (prev-then-next) order, dedupe by attachment id, truncate at the
  // cap keeping oldest-first -- so the carried image survives even a caption that
  // itself carries MEDIA_MAX_ATTACHMENTS. See the M3 spec.
  _coalesce(prev, next) {
    const decision = prev.decision === "respond" || next.decision === "respond" ? "respond" : "prefilter";
    const seen = new Set();
    const media = [];
    for (const m of [...(prev.media || []), ...(next.media || [])]) {
      if (media.length >= MEDIA_MAX_ATTACHMENTS) break; // before the push, so max=0 keeps nothing
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      media.push(m);
    }
    return { id: next.id, message: next.message, decision, media };
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
    // Shed the trigger entirely once its budget key is over the hourly budget --
    // the loop terminator. Dropping here (rather than queuing) is what actually
    // stops a bot ping-pong: every fresh message flows through here, so a runaway
    // channel stops spawning runs while other channels are untouched.
    const budgetKey = this._budgetKey(channelId, item);
    if (this._overBudget(budgetKey)) {
      logErr(`[${budgetKey}] per-channel run budget reached (${this.maxRunsPerWindow}/${Math.round(this.windowMs / 60000)}m); dropping trigger`);
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
    this._recordRun(this._budgetKey(channelId, message)); // count against the per-channel budget
    this.active++;
    Promise.resolve()
      .then(() => this.runFn(channelId, message))
      .catch((err) => logErr(`[${channelId}] run failed: ${err?.message ?? err}`))
      .finally(() => {
        this.busy.delete(channelId);
        this.active--;
        // Put this channel's own follow-up at the BACK of waiting (don't
        // dispatch it directly -- that would steal the freed slot and starve
        // other waiters).
        const q = this.queued.get(channelId);
        if (q !== undefined) { this.queued.delete(channelId); this._merge(this.waiting, channelId, q); }
        // Start the front waiter into the freed slot, RE-CHECKING the budget as we
        // go. A waiter was admitted while its budget key was under budget, but when
        // the dispatch key != budget key (ReactionDispatcher: many messageId
        // waiters share one channel budget) a burst can park a backlog that an
        // unconditional drain would run past the cap. Drop over-budget waiters
        // (they can't run this window, and skipping them stops an over-budget key
        // from head-blocking others) and start the first eligible one.
        for (const [key, item] of this.waiting) {
          this.waiting.delete(key);
          const bk = this._budgetKey(key, item);
          if (this._overBudget(bk)) {
            logErr(`[${bk}] per-channel run budget reached (${this.maxRunsPerWindow}/${Math.round(this.windowMs / 60000)}m); dropping queued trigger`);
            continue;
          }
          this._start(key, item);
          break;
        }
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

  // Budget reaction runs per CHANNEL, not per reacted-message (the dispatch key).
  // shouldHandleReaction fires on reactions to ANY of Baxter's messages including
  // old ones, so a per-message budget lets a reactor cycle across N old messages
  // for N separate budgets -- unbounded in aggregate. Keying the budget on the
  // channelId (carried on every reaction item) caps total reaction runs per
  // channel/hour regardless of how many messages the reactor spreads across.
  _budgetKey(_messageId, item) {
    return item.channelId;
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
    // Injection-safe (slug + date only) -- see projectsPreamble.
    PROJECTS_LIST: projectsPreamble(),
    // Injection-safe (learned-skill NAMES only, sanitized) -- see skillsPreamble.
    LEARNED_SKILLS_LIST: skillsPreamble(),
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
async function handleChannel(client, channelId, message, decision, media) {
  const selfId = client.user.id;
  const raw = await client.rest.get(`/channels/${channelId}/messages?limit=${Math.min(100, HISTORY_LIMIT)}`);
  const history = raw.reverse(); // Discord returns newest-first; make it chronological
  // Route this run to the multimodal model with the media attached, but only when
  // there IS media and a multimodal model is configured. The runner reads both from
  // the env (BAXTER_MODEL_OVERRIDE picks the model, BAXTER_MEDIA carries the parts);
  // absent -> the run behaves exactly as a text run.
  const useMedia = MULTIMODAL_MODEL && media && media.length > 0;
  const mediaEnv = useMedia
    ? { BAXTER_MODEL_OVERRIDE: MULTIMODAL_MODEL, BAXTER_MEDIA: JSON.stringify(media) }
    : {};
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
    // EXPECT_REPLY (all message runs): poke once if the model composes an answer
    // but never sends it. REPLY_REQUIRED (only a "respond" decision -- a real DM/
    // @mention/reply-to-Baxter): a reply is genuinely OWED, so the runner nudges an
    // empty turn harder. A "prefilter" run (channel chatter not addressed to Baxter)
    // leaves it unset, so an empty turn there is accepted -- staying quiet is right.
    // Neither is set on the reaction run below (a reaction is bias-to-no-op).
    env: { ...RUN_ENV, BAXTER_EXPECT_REPLY: "1", BAXTER_REPLY_REQUIRED: decision === "respond" ? "1" : "", ...mediaEnv },
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
      // Count before the POST (see gmail sendRaw / discord-cli sendMessage): a
      // record failure then suppresses the notice (fail-closed), and a POST
      // failure over-counts by one -- the safe direction for a flood guard,
      // rather than leaking the cap on a genuinely-delivered notice.
      await recordDiscordSend();
      await client.rest.post(`/channels/${channelId}/messages`, {
        body: { content: `${PERSONA_NAME} is out of tokens right now and couldn't get to this -- ping me again later.` },
      });
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
    // (see MAX_RUNS_PER_CHANNEL_PER_HOUR).
    maxRunsPerWindow: MAX_RUNS_PER_CHANNEL_PER_HOUR,
    // The dispatcher's own catch logs failures, so no .catch here.
    runFn: (channelId, m) => handleChannel(client, channelId, m.message, m.decision, m.media),
  });
  // Reactions to Baxter's own messages debounce per-message (same 4s window as
  // messages), then wake a reaction-specific run under a separate, smaller cap.
  const reactionDispatcher = new ReactionDispatcher({
    debounceMs: DEBOUNCE_MS,
    maxConcurrent: REACTION_MAX_CONCURRENT,
    // Same budget, applied per CHANNEL (via ReactionDispatcher._budgetKey, since
    // this dispatcher's own key is the messageId). Reaction runs are no-op-biased
    // and so never hit DISCORD_MAX_SENDS_PER_DAY, which would otherwise leave
    // nothing bounding the run COUNT from external reaction churn -- a reactor
    // cycling reactions across Baxter's messages spawns a run per debounce window.
    // Keying per channel bounds the whole vector, not just single-message spam.
    maxRunsPerWindow: MAX_RUNS_PER_CHANNEL_PER_HOUR,
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
      // #baxter-logs-* -- never a trigger (no self-log loop). Check the parent too
      // so a THREAD under a log channel (message.channelId is the thread id) is
      // covered as well.
      const inLogChannel = LOG_EXCLUDE_CHANNELS.has(message.channelId) || LOG_EXCLUDE_CHANNELS.has(message.channel?.parentId);
      if (inLogChannel) return;
      if (GUILD_ALLOWLIST.length && message.guildId && !GUILD_ALLOWLIST.includes(message.guildId)) return;
      let repliesToBot = false;
      if (message.reference?.messageId) {
        const ref = await message.fetchReference().catch(() => null);
        repliesToBot = ref?.author?.id === selfId;
      }
      const descriptor = {
        authorId: message.author.id,
        isLogChannel: inLogChannel, // re-checked in classifyMessage, defensively
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
      dispatcher.notify(message.channelId, { id: message.id, message, decision, media: selectMediaAttachments(message, { max: MEDIA_MAX_ATTACHMENTS }) });
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

  // Auto-exclude the log-mirror channels so their webhook posts can't self-trigger,
  // even if DISCORD_LOG_EXCLUDE_CHANNELS wasn't set. Resolve BEFORE login so the set
  // is populated before any message flows.
  try {
    const resolved = await resolveLogWebhookChannels(process.env);
    for (const id of resolved) LOG_EXCLUDE_CHANNELS.add(id);
    if (resolved.size) log(`log-mirror: auto-excluding ${resolved.size} webhook channel(s) from triggers`);
  } catch (err) {
    logErr(`log-mirror: channel auto-resolve failed (using DISCORD_LOG_EXCLUDE_CHANNELS only): ${err?.message ?? err}`);
  }
  const anyLogWebhook = Object.keys(process.env).some((k) => /^DISCORD_LOG_WEBHOOK/.test(k) && process.env[k]);
  if (anyLogWebhook && LOG_EXCLUDE_CHANNELS.size === 0) {
    logErr("WARNING: DISCORD_LOG_WEBHOOK* is set but no log channels are excluded -- the log mirror will self-trigger. Set DISCORD_LOG_EXCLUDE_CHANNELS.");
  }

  await client.login(TOKEN);
}

// Only run the daemon when invoked directly, not when a test imports the pure
// functions (classifyMessage/ChannelDispatcher/renderHistory).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
