#!/usr/bin/env node
// Token-scoped Discord REST CLI. The ONLY component besides discord-bot.mjs
// that reads DISCORD_BOT_TOKEN -- the spawned claude -p run reaches Discord
// only through `Bash(discord-cli *)`, never the raw token (mirrors gmail.mjs).
// Uses raw fetch to the REST API v10; no discord.js / no gateway.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
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
  recordDiscordSend();
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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , cmd, ...rest] = process.argv;
  try {
    // Inside the try so parseFlags's "missing value" throw gets the one-line
    // error path below, not an uncaught stack trace (the spawned run reads stderr).
    const { positionals, flags } = parseFlags(rest);
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
      case "unreact": // remove Baxter's OWN reaction only (the /@me endpoint); not moderation
        await api("DELETE", `/channels/${positionals[0]}/messages/${positionals[1]}/reactions/${encodeEmoji(positionals[2])}/@me`);
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
        console.error("Usage: discord-cli <whoami|send|reply|react|unreact|fetch-history|create-thread|send-thread|edit|delete-own|pin|unpin|typing> [args]");
        process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
