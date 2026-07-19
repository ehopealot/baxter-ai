#!/usr/bin/env node
// Token-scoped Discord REST CLI. The ONLY component besides discord-bot.mjs
// that reads DISCORD_BOT_TOKEN -- the spawned claude -p run reaches Discord
// only through `Bash(discord-cli *)`, never the raw token (mirrors gmail.mjs).
// Uses raw fetch to the REST API v10; no discord.js / no gateway.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { basename } from "node:path";
import { DISCORD_MAX_SENDS_PER_DAY, loadDiscordSendState, recordDiscordSend } from "./send-state.mjs";
import { DISCORD_TOKEN_PATH } from "./paths.mjs";

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
      // Slice by UTF-16 units but never bisect a surrogate pair -- a lone
      // surrogate becomes U+FFFD when the chunk is UTF-8-encoded into the
      // request body, corrupting emoji/astral chars that straddle a boundary.
      for (let i = 0; i < line.length; ) {
        let end = Math.min(i + max, line.length);
        const c = line.charCodeAt(end - 1);
        if (end < line.length && c >= 0xd800 && c <= 0xdbff) end--; // high surrogate at the cut
        if (end === i) end = i + 1; // pathological max<2: accept the split rather than hang
        chunks.push(line.slice(i, end));
        i = end;
      }
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

// A Discord snowflake id encodes its creation time: id = ((ms - DISCORD_EPOCH)
// << 22). So a timestamp maps to a boundary snowflake usable as `before`/`after`
// in a message fetch -- that's how we get time-ranged history (Discord has no
// server-side message search for bots). `--since`/`--until` take a timestamp and
// go through here; `--before`/`--after` take a raw snowflake and are used as-is.
const DISCORD_EPOCH = 1420070400000n; // 2015-01-01T00:00:00Z, in ms
export function tsToSnowflake(ts) {
  if (ts == null || ts === "") return undefined;
  // All-digits -> epoch milliseconds; anything else -> a parseable date string.
  const ms = /^\d+$/.test(String(ts)) ? Number(ts) : Date.parse(String(ts));
  if (!Number.isFinite(ms)) throw new Error(`invalid timestamp "${ts}" (use ISO 8601 like 2026-07-18T14:00:00Z, or epoch milliseconds)`);
  const big = BigInt(Math.floor(ms));
  if (big < DISCORD_EPOCH) throw new Error(`timestamp "${ts}" predates Discord (2015) -- did you pass epoch SECONDS instead of milliseconds?`);
  return ((big - DISCORD_EPOCH) << 22n).toString();
}

// Minimal flag parser: `--key value` pairs become flags; everything else is a
// positional. No `--key=value`, no booleans (none needed by this CLI). A bare
// `--` ends flag parsing so the rest are positionals verbatim -- important
// because positionals include agent-authored free text (e.g. a thread name)
// that can legitimately start with `--`. A dangling `--flag` with no value is
// an error rather than a silent `undefined`.
export function parseFlags(args) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") { positionals.push(...args.slice(i + 1)); break; }
    if (args[i].startsWith("--")) {
      if (i + 1 >= args.length) throw new Error(`missing value for --${args[i].slice(2)}`);
      flags[args[i].slice(2)] = args[++i];
    } else positionals.push(args[i]);
  }
  return { positionals, flags };
}

// Pull every `--file <path>` out of args (parseFlags keeps only the last of a
// repeated flag), returning the paths and the remaining args for parseFlags.
export function extractFiles(args) {
  const files = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    // Stop extracting at the `--` sentinel and pass it plus everything after
    // through untouched, so parseFlags' own `--` handling still sees it and
    // positionals that legitimately start with `--file` survive verbatim.
    if (args[i] === "--") { rest.push(...args.slice(i)); break; }
    if (args[i] === "--file") {
      if (i + 1 >= args.length) throw new Error("missing value for --file");
      files.push(args[++i]);
    } else rest.push(args[i]);
  }
  return { files, rest };
}

export function buildAttachmentPayload(content, extra, filePaths) {
  return {
    content,
    ...extra,
    attachments: filePaths.map((p, id) => ({ id, filename: basename(p) })),
  };
}

// Env first (e.g. running discord-cli directly), else the file the daemon wrote
// at startup. The spawned claude run has DISCORD_BOT_TOKEN stripped from its
// env, so it drives discord-cli via the file without the token ever entering
// its environment -- mirrors gmail.mjs reading gmail-token.json rather than env.
function token() {
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN;
  try {
    const t = JSON.parse(readFileSync(DISCORD_TOKEN_PATH, "utf8")).token;
    if (t) return t;
  } catch {
    /* fall through to the error below */
  }
  throw new Error("DISCORD_BOT_TOKEN is not set (no env var and no token file)");
}

// One REST call with bot auth and one 429 retry honoring retry_after. Returns
// parsed JSON (or null for 204). Throws on non-2xx with the response body.
async function api(method, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const isForm = body instanceof FormData;
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token()}`,
        "User-Agent": "BaxterBurgundy (https://example.invalid, 1.0)",
        ...(isForm ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    if (res.status === 429) {
      const info = await res.json().catch(() => ({}));
      const waitMs = Math.ceil((info.retry_after ?? 1) * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      // Carry the HTTP status structurally (not just in the message) so callers can
      // classify robustly -- e.g. fetchHistoryMulti skips a 403/404 channel but
      // rethrows other statuses. Mirrors local-runner.mjs's err.status pattern.
      const err = new Error(`Discord ${method} ${path} -> ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`Discord ${method} ${path}: rate-limited twice`);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// Enforces the daily Discord send cap at the actual post (the only place it has
// teeth), mirroring gmail.mjs's recordSend. One logical send (send/reply/
// send-thread) counts once even if chunked, and is refused when the day's count
// is already at the cap -- an operational flood guard, not a permission.
async function sendMessage(channelId, content, extra = {}) {
  const { count } = loadDiscordSendState();
  if (count >= DISCORD_MAX_SENDS_PER_DAY) {
    throw new Error(`Discord daily send cap reached (${count}/${DISCORD_MAX_SENDS_PER_DAY}); message not sent`);
  }
  // Count the attempt up front, not after the loop: a multi-chunk send that
  // fails partway has already posted real messages, so recording only on full
  // success would let a persistently-failing retry re-post its leading chunks
  // unbounded while the counter stays frozen. Over-counting a failed send is
  // the safe direction for a flood guard.
  await recordDiscordSend();
  const parts = chunkMessage(content);
  let last = null;
  for (const part of parts) last = await api("POST", `/channels/${channelId}/messages`, { content: part, ...extra });
  return last; // id of the final message posted
}

// Posts a single message with one or more file attachments (multipart). Unlike
// sendMessage, this never chunks -- Discord attaches files to one post -- so
// content over 2000 chars alongside files will 400 (surfaced as a clear API
// error rather than silently mis-attaching to a later chunk).
async function sendWithFiles(channelId, content, extra, filePaths) {
  const { count } = loadDiscordSendState();
  if (count >= DISCORD_MAX_SENDS_PER_DAY) throw new Error(`Discord daily send cap reached (${count}/${DISCORD_MAX_SENDS_PER_DAY}); message not sent`);
  const MAX = 25 * 1024 * 1024;
  const bufs = filePaths.map((p) => {
    let buf;
    try { buf = readFileSync(p); } catch { throw new Error(`--file not readable: ${p}`); }
    if (buf.length > MAX) throw new Error(`--file too large for Discord (${p}, ${buf.length} bytes > 25MB)`);
    return buf;
  });
  await recordDiscordSend();
  const form = new FormData();
  form.append("payload_json", JSON.stringify(buildAttachmentPayload(content, extra, filePaths)));
  bufs.forEach((buf, i) => form.append(`files[${i}]`, new Blob([buf]), basename(filePaths[i])));
  return api("POST", `/channels/${channelId}/messages`, form);
}

// Fetch channel history, optionally bounded by time and/or author. Discord has no
// server-side message search for bots, so this pages backward (newest-first,
// `before`) from the upper bound and filters client-side:
//   limit   max messages RETURNED (after filtering; the newest matching ones)
//   before  raw snowflake upper bound (exclusive); until = a timestamp for the same
//   after   raw snowflake lower bound (exclusive); since = a timestamp for the same
//   from    keep only messages by this author id
//   contains keep only messages whose content includes this substring (case-
//            insensitive, fixed-string -- e.g. a user id to find `<@id>` mentions)
// The scan is capped at MAX_PAGES (~2000 messages) in ALL cases so an author/time
// filter that rarely matches can't page the whole channel. A time window normally
// stops the scan sooner (at the lower bound); if the cap fires BEFORE reaching that
// bound, the result may be only the newest slice of the window -- a warning is
// printed to stderr (stdout stays clean JSON) so the caller doesn't mistake it for the full
// range. Returns newest-first; the caller reverses to chronological. `_api` is an
// injectable fetcher for tests (defaults to the real REST call).
export async function fetchHistory(channelId, opts = {}) {
  const call = opts._api ?? api;
  // Reject a bad --limit loudly rather than silently coercing (abc -> 100, 0 -> []):
  // a silent empty result reads as an empty channel; same fail-loud rule the rest
  // of the project uses for numeric knobs.
  const limit = opts.limit == null ? 100 : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`invalid --limit "${opts.limit}" (must be a positive integer)`);
  const from = opts.from;
  // Fixed-string (no regex -> no ReDoS on a model-supplied needle, like files-cli's
  // grep), case-insensitive content substring filter.
  const needle = opts.contains != null && opts.contains !== "" ? String(opts.contains).toLowerCase() : null;
  const beforeCursor = opts.before ?? tsToSnowflake(opts.until);
  const sinceId = opts.after ?? tsToSnowflake(opts.since);
  const sinceBig = sinceId ? BigInt(sinceId) : null;
  const MAX_PAGES = opts.maxPages ?? 20; // 20 * 100 = up to 2000 messages scanned
  const out = [];
  let cursor = beforeCursor;
  let hitSince = false;
  let pages = 0;
  for (; pages < MAX_PAGES && out.length < limit; pages++) {
    const q = new URLSearchParams({ limit: "100" });
    if (cursor) q.set("before", cursor);
    const batch = await call("GET", `/channels/${channelId}/messages?${q}`);
    if (!batch.length) break;
    for (const m of batch) { // newest-first within the page
      if (sinceBig && BigInt(m.id) <= sinceBig) { hitSince = true; break; } // reached the lower time bound
      if (from && m.author?.id !== from) continue;
      if (needle && !String(m.content ?? "").toLowerCase().includes(needle)) continue;
      out.push(m);
      if (out.length >= limit) break;
    }
    cursor = batch[batch.length - 1].id;
    if (hitSince || batch.length < 100) break;
  }
  // If the page cap (not --limit and not the lower bound) ended the scan, the
  // result may be only the newest slice scanned -- true for a time window OR an
  // open-ended --from that matched too few. Warn on stderr (stdout stays clean
  // JSON) so the agent doesn't treat a possibly-truncated scan as the complete range.
  if (!hitSince && pages >= MAX_PAGES && out.length < limit) {
    const before = sinceBig ? "reaching --since/--after" : "satisfying --limit";
    // "may be": the cap also trips when a channel ends at exactly MAX_PAGES full
    // pages (a complete scan), and telling those apart would cost an extra fetch.
    console.error(`discord-cli fetch-history: channel ${channelId}: hit the ${MAX_PAGES}-page scan cap (~${MAX_PAGES * 100} messages) before ${before}; results may be only the newest slice scanned, not the full range.`);
  }
  return out; // newest-first; caller reverses for chronological rendering
}

// A Discord channel id is a snowflake: a 17-20 digit number. Reject anything else
// up front with a hint, so `fetch-history <ch> 48` (48 = a mistaken positional
// limit) fails clearly instead of 404-ing on "channel 48".
export function assertChannelId(id) {
  if (!/^\d{17,20}$/.test(String(id))) {
    const hint = /^\d+$/.test(String(id)) ? ` -- did you mean --limit ${id}?` : "";
    throw new Error(`"${id}" is not a valid channel id (Discord ids are 17-20 digit numbers)${hint}`);
  }
}

// Fetch history from one OR MORE channels with the same filters, merged into a
// single chronological (oldest-first) array. Each message is tagged with its
// channel_id (Discord already includes it; set defensively) so a multi-channel
// result stays attributable. Sorted by snowflake id, which is a strict time order
// across channels. Each channel is scanned independently (so `limit` is per-
// channel, and each may print its own truncation warning).
export async function fetchHistoryMulti(channelIds, opts = {}) {
  // Dedupe (a Set preserves insertion order): a repeated id -- easy in a
  // model-assembled arg list -- would otherwise fetch that channel twice and
  // return every message doubled, plus double the scan cost.
  const unique = [...new Set(channelIds)];
  const all = [];
  let ok = 0;
  let firstErr = null;
  for (const ch of unique) {
    try {
      for (const m of await fetchHistory(ch, opts)) {
        if (m.channel_id == null) m.channel_id = ch;
        all.push(m);
      }
      ok++;
    } catch (e) {
      // Skip only a genuinely unreadable/missing channel (a 403/404) rather than
      // sinking a whole multi-channel search on one bad id -- warn so it's visible.
      // Anything else (rate-limit exhaustion under the multi-channel fan-out, a
      // transient 5xx/network error) is NOT the channel's fault and is retriable,
      // so rethrow it rather than silently dropping that channel's data into a
      // partial result that looks complete. (If every channel 403/404s we still
      // throw below via the ok===0 backstop.) Classifies on the structured
      // e.status api() attaches, not the message text.
      if (e.status !== 403 && e.status !== 404) throw e;
      firstErr = firstErr ?? e;
      console.error(`discord-cli fetch-history: channel ${ch}: ${e.message}`);
    }
  }
  if (ok === 0 && firstErr) throw firstErr; // nothing succeeded -> surface the failure, don't return []
  all.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
  return all; // oldest-first (chronological)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , cmd, ...rest] = process.argv;
  try {
    // Inside the try so parseFlags's "missing value" throw gets the one-line
    // error path below, not an uncaught stack trace (the spawned run reads stderr).
    const { files, rest: restArgs } = extractFiles(rest);
    const { positionals, flags } = parseFlags(restArgs);
    switch (cmd) {
      case "whoami":
        console.log(JSON.stringify(await api("GET", "/users/@me")));
        break;
      case "send":
        console.log(JSON.stringify(files.length
          ? await sendWithFiles(positionals[0], await readStdin(), {}, files)
          : await sendMessage(positionals[0], await readStdin())));
        break;
      case "reply": {
        const extra = { message_reference: { message_id: positionals[1] } };
        const body = await readStdin();
        console.log(JSON.stringify(files.length
          ? await sendWithFiles(positionals[0], body, extra, files)
          : await sendMessage(positionals[0], body, extra)));
        break;
      }
      case "dm": {
        // Open (or reuse) a DM channel with a user, then send there. Same body-on-stdin
        // + optional --file contract as `send`. GATED: a DM is a private, unaudited
        // message to ANY user sharing a guild with the bot -- wider reach than a
        // (visible, moderatable) channel post -- so it's refused unless DISCORD_ALLOW_DM=1
        // is in the run env. Only the voice-dispatch runs set it (see voice-bot's RUN_ENV);
        // the email/discord/heartbeat runs (whose inputs are attacker-influenced) can't DM.
        if (process.env.DISCORD_ALLOW_DM !== "1") {
          console.error("discord-cli dm is disabled for this run (DISCORD_ALLOW_DM not set)");
          process.exit(1);
        }
        const dm = await api("POST", "/users/@me/channels", { recipient_id: positionals[0] });
        const body = await readStdin();
        console.log(JSON.stringify(files.length
          ? await sendWithFiles(dm.id, body, {}, files)
          : await sendMessage(dm.id, body)));
        break;
      }
      case "react":
        await api("PUT", `/channels/${positionals[0]}/messages/${positionals[1]}/reactions/${encodeEmoji(positionals[2])}/@me`);
        break;
      case "unreact": // remove Baxter's OWN reaction only (the /@me endpoint); not moderation
        await api("DELETE", `/channels/${positionals[0]}/messages/${positionals[1]}/reactions/${encodeEmoji(positionals[2])}/@me`);
        break;
      case "fetch-history": {
        if (!positionals.length) throw new Error("fetch-history: at least one channelId is required");
        for (const ch of positionals) assertChannelId(ch); // catch a stray --limit-as-positional early
        const msgs = await fetchHistoryMulti(positionals, {
          limit: flags.limit, before: flags.before, after: flags.after,
          since: flags.since, until: flags.until, from: flags.from, contains: flags.contains,
        });
        console.log(JSON.stringify(msgs)); // chronological (merged across channels; each msg carries channel_id)
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
        console.log(JSON.stringify(files.length
          ? await sendWithFiles(positionals[0], await readStdin(), {}, files)
          : await sendMessage(positionals[0], await readStdin())));
        break;
      case "edit":
        await api("PATCH", `/channels/${positionals[0]}/messages/${positionals[1]}`, { content: await readStdin() });
        break;
      case "delete-own": {
        // "own" is enforced in code, not just named: with Manage Messages the
        // bot could delete anyone's message, so verify authorship first (the
        // membership-style guardrails live in plain code, not prompt text).
        const meId = (await api("GET", "/users/@me")).id;
        const target = await api("GET", `/channels/${positionals[0]}/messages/${positionals[1]}`);
        if (target.author?.id !== meId) throw new Error("delete-own: not your message");
        await api("DELETE", `/channels/${positionals[0]}/messages/${positionals[1]}`);
        break;
      }
      case "delete-any":
        // Moderation delete of ANY author's message -- deliberately NO code
        // author-check (that's the whole point vs delete-own). The gate is
        // Discord's own per-channel Manage Messages permission, which the
        // operator grants only in the specific channels where Baxter may
        // moderate: deleting ANOTHER user's message returns 403 anywhere that
        // permission is absent, so the bot physically cannot moderate others'
        // messages outside those channels. (Deleting its OWN message needs no
        // such permission and works anywhere -- delete-own is the clearer path
        // for that.) Unlike delete-own, this is a real capability expansion
        // beyond "act as yourself" -- kept a distinct command name so the two
        // are never conflated, and it can't reach another user's message the
        // server hasn't authorized it to.
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
        console.error("Usage: discord-cli <whoami|send|reply|dm|react|unreact|fetch-history|create-thread|send-thread|edit|delete-own|delete-any|pin|unpin|typing> [args]");
        process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
