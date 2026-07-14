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

// Entry guard: only run if directly invoked (not imported)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("Discord bot daemon not yet implemented");
  process.exit(1);
}
