---
name: web
description: Search the web (web-cli search <query>) and fetch a page's text (web-cli fetch <url>) from the command line -- fast, keyless, no browser. Search is backed by a self-hosted SearXNG. Fall back to playwright-cli/invisible-cli only when a page needs JavaScript or is bot-walled.
allowed-tools: Bash(web-cli:*)
---

# Web access with web-cli

`web-cli` gives you keyless web **search** and **fetch**. It reaches the network
directly (no browser), so it's fast — but `fetch` does **not** run a page's
JavaScript, and it holds no credentials.

## Commands

- `web-cli search <query>` — search the web and get back a ranked list of
  **title / url / snippet** (plus any direct answer and related searches). Backed
  by a self-hosted SearXNG that aggregates real engines. Then `web-cli fetch
  <result-url>` to read a specific page.
- `web-cli fetch <url> [--max-bytes N]` — GET the URL and return its **readable
  text** (HTML is stripped to text; JSON/plain is returned as-is). http/https
  only; leads with the final URL + page title.

## Searching

Reach for `web-cli search <query>` first — it's the quick, keyless way to find
pages:

```
web-cli search best static site generators 2026
web-cli fetch https://<a-result-url>       # then read the one you want
```

If search errors out for any reason — backend unreachable, an HTTP error from
SearXNG, or a timeout — fall back to opening **Bing** in the browser (Bing serves
automated requests where Google shows a CAPTCHA) — use `playwright-cli`, NOT
`invisible-cli` (the stealth Firefox is slow to start; save it for a *specific*
bot-walled page, never for search):

```
playwright-cli open "https://www.bing.com/search?q=YOUR+QUERY"
playwright-cli snapshot
```

## When to fall back to the browser for a page

`web-cli fetch` reads raw HTML, so it can't see content a page renders with
JavaScript. If a fetch comes back thin, empty, or clearly missing content that
should be there (a JS-heavy/SPA page, infinite scroll, a cookie/consent or login
wall), open the page in **`playwright-cli`** — it runs the page's JS and gives you
the rendered DOM. **To just read the page, `open` then `snapshot`:**

```
playwright-cli open "https://the-page"
playwright-cli snapshot                 # the rendered, AI-readable page text
```

Use **`run-code`** only when you need to *extract a specific slice* or *interact*
(click / scroll / fill a form) — not for a plain read, where `snapshot` is
simpler. `run-code` runs against an **already-open** browser, so `open` the page
first (a self-navigating script still errors with "Browser is not open"
otherwise).

Reach for `web-cli` first for quick lookups; escalate to `playwright-cli` the
moment it under-delivers, and prefer `snapshot` over hand-written `run-code` to
read what it renders.

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
