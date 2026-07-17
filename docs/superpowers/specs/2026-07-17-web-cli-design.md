# web-cli — web fetch + search as a CLI (design)

**Date:** 2026-07-17
**Status:** approved, building

## Goal

Give the agent run **web fetch + web search** as a credential-less CLI (`web-cli`)
so any harness can use it — Claude via `Bash(web-cli *)`, OpenRouter via `run_cli`.
This fills the OpenRouter harness's deferred native web tools without needing
harness-specific support. Zero config (no API keys); when the web is JS-heavy or
search is blocked, the run **falls back to `playwright-cli`/`invisible-cli`**
(already the run prompts' guidance).

## CLI

`scripts/web-cli.mjs` — a Node CLI on PATH as `web-cli` (Dockerfile shim, same
pattern as `discord-cli`/`code-cli`), raw `fetch`, no deps, holds no secret. Runs
in the daemon container (which has outbound network).

- **`web-cli fetch <url> [--max-bytes N]`** — http/https only; GET with a timeout,
  size cap, a real User-Agent, and redirect-follow. If the response is HTML,
  convert to **readable text** (drop `<script>`/`<style>`/`<noscript>`, strip
  tags, decode common entities, collapse whitespace); non-HTML (JSON/plain) is
  printed raw. Output leads with the final URL + `<title>`, then the text, and
  notes truncation. Parity with Claude's `WebFetch` (raw HTML, no JS execution).
- **`web-cli search <query> [--n N]`** — DuckDuckGo's keyless HTML endpoint
  (`https://html.duckduckgo.com/html/?q=…`). Parse result blocks into
  `title · url · snippet`, decoding DDG's `/l/?uddg=<real-url>` redirect wrapper
  to the real URL; return the top N (default 8). On empty/blocked, print a clear
  "no results (DuckDuckGo may be blocking) — try `playwright-cli`" note rather
  than a bare empty result.

## Security

- **Scheme allowlist:** only `http`/`https` (no `file:`, `data:`, etc.).
- **Light internal-target blocklist:** refuse `localhost`, loopback, and
  private/link-local IP *literals* (`127.*`, `10.*`, `192.168.*`, `172.16–31.*`,
  `169.254.*`, `::1`) and the `codapi` host. This is **not** full
  DNS-rebinding-proof SSRF protection — a hostname resolving to a private IP still
  gets through — which is the **same accepted residual** as the existing browser
  CLIs (per `app/CLAUDE.md`, internal reachability via the browser CLIs, incl.
  the unauthenticated codapi, is a known residual). No new credential surface.
- No secret in the CLI; nothing written to disk.

## Wiring

- **`skills/web/SKILL.md`** documenting both subcommands + the playwright fallback;
  added to each daemon's `SKILL_SRCS` and to `BAKED_SKILL_NAMES` (learned skills
  can't shadow it).
- **Grant `Bash(web-cli *)`** in the three daemons' `ALLOWED_TOOLS` — OpenRouter's
  `run_cli` allowlist picks it up automatically; the Claude runs get it too
  (alongside their native `WebFetch`/`WebSearch`).
- **Dockerfile shim** installing `web-cli` on PATH.

## Testing

Unit-test the pure parts (no network): the HTML→text conversion, DDG result-block
parsing (including `/l/?uddg=` URL decoding), and the URL scheme/internal-target
guard. The live fetch/search is verified manually (the CLI reaches the real net).

## Non-goals (v1)

JS rendering (that's `playwright-cli`), API-key search providers (DDG only),
pagination, and `web-cli`-in-codapi (codapi is `network:none` by design).
