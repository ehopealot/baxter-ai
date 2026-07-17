---
name: web
description: Fetch a web page's text (web-cli fetch <url>) or run a keyless web search (web-cli search <query>) from the command line. Fast, but reads raw HTML -- fall back to playwright-cli/invisible-cli when a page needs JavaScript or search gets blocked.
allowed-tools: Bash(web-cli:*)
---

# Web access with web-cli

`web-cli` gives you keyless web **fetch** and **search**. It reaches the network
directly (no browser), so it's fast — but it does **not** run a page's
JavaScript, and it holds no credentials.

## Commands

- `web-cli fetch <url> [--max-bytes N]` — GET the URL and return its **readable
  text** (HTML is stripped to text; JSON/plain is returned as-is). http/https
  only; leads with the final URL + page title.
- `web-cli search <query> [--n N]` — web **search** via DuckDuckGo (no key).
  Returns the top N results as `title / url / snippet` (default 8).

## When to fall back to the browser

`web-cli` reads raw HTML, so it can't see content a page renders with JavaScript,
and DuckDuckGo occasionally rate-limits or blocks the search endpoint. So:

- If `web-cli fetch` comes back thin, empty, or clearly missing content that
  should be there (a JS-heavy/SPA page, infinite scroll, a cookie/consent or
  login wall), open the page with **`playwright-cli`** (or **`invisible-cli`**
  for bot-walled sites) — those run the page's JS and give you the rendered DOM.
- If `web-cli search` reports no results, retry once or refine the query; if it
  keeps failing, search interactively with `playwright-cli`.

Reach for `web-cli` first for quick lookups; escalate to the browser the moment
it under-delivers.
