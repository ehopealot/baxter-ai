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
