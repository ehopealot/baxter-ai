// Fallback chain: when the fast path (web-cli, raw HTML) hits a bot wall, he should
// escalate to the ANTI-DETECT browser (invisible-cli) -- the whole reason it exists
// ('Just a moment…' / Cloudflare, per the web + invisible-playwright skills). Modeled
// realistically: web-cli returns a Cloudflare interstitial AND plain playwright-cli is
// ALSO blocked (regular automation is detected), so the ONLY path to the content is
// invisible-cli -- a delivered answer therefore implies he found the stealth browser.
// Baseline (a routing judgment): run it, lock in the rate, watch for a drop.
import { calledTool, delivered, succeeded } from "../assertions.mjs";
export default {
  name: "discord: falls back to invisible-cli when web-cli is bot-blocked",
  surface: "discord",
  slots: {
    HISTORY: "[10:10] erik (msg msg1): can you pull the current price of the Aeron chair (size B, graphite) from chairstore.example and tell me?",
    TRIGGER_AUTHOR: "erik",
  },
  mocks: {
    // web-cli fetch -> a Cloudflare "Just a moment…" challenge page (200 w/ challenge HTML).
    "web-cli": {
      fetch: "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser before accessing chairstore.example. This process is automatic. Please enable JavaScript and cookies to continue. Cloudflare Ray ID: 8ab3f0c1 (cf-chl-bypass).</body></html>",
      "*": "",
    },
    // plain playwright-cli is detected and blocked too -- only anti-detect gets through.
    "playwright-cli": { "*": "Attention Required! | Cloudflare — Sorry, you have been blocked. You are unable to access chairstore.example (automated request detected)." },
    // invisible-cli (anti-detect Firefox) succeeds; return the content for any subcommand.
    "invisible-cli": { "*": "Aeron Chair (Size B, Graphite) — $1,795.00. In stock. Free shipping. 4.8/5 (2,301 reviews)." },
  },
  expect: [
    calledTool("web-cli"),         // tried the fast path first
    calledTool("invisible-cli"),   // escalated to the anti-detect browser on the bot wall
    delivered(),                   // and got the answer out (only invisible-cli had it)
    succeeded(),
  ],
};
