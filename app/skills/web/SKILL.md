---
name: web
description: Fetch a web page's text (web-cli fetch <url>) from the command line -- fast, but reads raw HTML. To SEARCH, open Bing in the browser (playwright-cli open "https://www.bing.com/search?q=...") -- web-cli's own search is disabled. Fall back to playwright-cli/invisible-cli when a page needs JavaScript.
allowed-tools: Bash(web-cli:*)
---

# Web access with web-cli

`web-cli` gives you keyless web **fetch**. It reaches the network directly (no
browser), so it's fast — but it does **not** run a page's JavaScript, and it holds
no credentials.

## Commands

- `web-cli fetch <url> [--max-bytes N]` — GET the URL and return its **readable
  text** (HTML is stripped to text; JSON/plain is returned as-is). http/https
  only; leads with the final URL + page title.
- `web-cli search <query>` — **disabled** (DuckDuckGo blocks the keyless endpoint).
  It just prints a reminder to search Bing in the browser instead (see below).

## Searching: use Bing in the browser

There's no command-line search. To search, open **Bing** in the browser and read
the results — Bing serves automated requests (Google shows a CAPTCHA):

```
playwright-cli open "https://www.bing.com/search?q=YOUR+QUERY"
playwright-cli snapshot
```

**Use `playwright-cli` for search, NOT `invisible-cli`** — Bing doesn't bot-wall, and
`invisible-cli` (the stealth Firefox) is slow to start and can stall (it now self-
recovers after ~45s rather than the old 2-minute wait, but that's still 45s wasted),
so reaching for it on a plain search just wastes time. Save `invisible-cli` for a
*specific* site that actively blocks `playwright-cli` (a Cloudflare "Just a moment…"
wall), never for search itself.
Once you have a specific result URL, `web-cli fetch <url>` is the quick way to read
it.

## When to fall back to the browser for a page

`web-cli fetch` reads raw HTML, so it can't see content a page renders with
JavaScript. If a fetch comes back thin, empty, or clearly missing content that
should be there (a JS-heavy/SPA page, infinite scroll, a cookie/consent or login
wall), open the page with **`playwright-cli`** — it runs the page's JS and gives
you the rendered DOM.

Reach for `web-cli` first for quick lookups; escalate to `playwright-cli` the
moment it under-delivers.

## Blocked by a bot-wall? Try `invisible-cli` ONCE

If a page you specifically need blocks `playwright-cli` — a Cloudflare
"Just a moment…" / "Checking your browser" interstitial, an "Access denied" /
HTTP 403 bot page, or a snapshot that stays stuck on such a challenge — **retry
that exact URL once with `invisible-cli`** (the stealth Firefox) before giving up
on it:

```
invisible-cli open "https://the-blocked-url"
invisible-cli snapshot
```

That is exactly what `invisible-cli` is for. It's slower to start (~10–20s) and now
self-recovers from a stuck command in ~30s, so it's a deliberate one-shot escalation
for a *specific* walled page — not something to use for search or for pages
`playwright-cli` already handles. If `invisible-cli` is also blocked, then move on.
