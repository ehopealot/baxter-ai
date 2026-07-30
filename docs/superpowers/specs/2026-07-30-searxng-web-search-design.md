# SearXNG web search for Baxter — design

**Status:** approved (2026-07-30). **Scope:** give Baxter a real command-line web
*search* backed by a self-hosted [SearXNG](https://github.com/searxng/searxng)
instance, by re-enabling the currently-disabled `web-cli search` verb.

## Problem

`web-cli search` exists but is **disabled** (`web-cli.ts` `cmdSearch`): it does no
network call, just prints instructions to open Bing in the browser via
`playwright-cli`. The `claude` harness has a native `WebSearch` tool, but the
**structured-tool harnesses (openrouter — the default, openai, custom) have no
real search at all** — their only web path is `web-cli fetch` plus Bing-in-browser.
So on the default harness, search is slow and browser-mediated.

## Approach

Re-point `cmdSearch` at a self-hosted SearXNG's JSON API. SearXNG aggregates many
upstream engines behind one keyless HTTP endpoint we control, on the fleet's own
network — no API key, no per-search cost, private.

### The tool — `web-cli search <query>`

- Calls `GET ${SEARXNG_URL:-http://searxng:8080}/search?q=<query>&format=json`.
  The host is **fixed by env, never model-controlled**, and keyless — so this adds
  **no SSRF surface** and needs no `guardUrl` (the fixed internal host is exactly
  what `guardUrl` *blocks*; `code-cli`/`data-cli` reach their internal services the
  same way). The result URLs are just text; when the model later `web-cli fetch`es
  one, that path re-applies `guardUrl`.
- `SEARXNG_URL` mirrors `code-cli`'s `CODAPI_URL` convention (env override, default
  = the compose service alias).
- Single `AbortController` timeout (reuse `FETCH_TIMEOUT_MS = 20s`) over fetch +
  body read; response capped via the shared `readCapped` (`SEARCH_MAX_BYTES = 1 MB`).
- Parses JSON, formats the top `SEARXNG_MAX_RESULTS` (default 8) as compact text:
  `Search: <q>` header, optional `Answer:` lines, then numbered `title / url /
  snippet`, optional `Related searches:` tail. Snippets are entity-decoded,
  tag-stripped, whitespace-collapsed, length-capped.
- Fail-soft, actionable errors: non-2xx → "is the searxng service running? (set
  SEARXNG_URL…)"; non-JSON body → "enable the JSON format in settings.yml
  (search.formats: [html, json])".

**Testability:** split into a pure `formatSearchResults(json, query, max)` and an
`performSearch(query, deps)` with an injectable `fetch` seam (mirroring
`data-cli`'s `FetchLike` stub). Both exported; unit-tested with no network.

### The service — `searxng` compose service

- `image: searxng/searxng`, network alias `searxng` (so `http://searxng:8080`
  resolves fleet-wide, exactly like `codapi`), codapi-style hardening
  (`restart`, `mem_limit`, `security_opt: no-new-privileges`).
- A mounted `app/searxng/settings.yml`: `use_default_settings: true`,
  `search.formats: [html, json]` (JSON is off by default), `server.limiter: false`
  + `public_instance: false` (internal instance, no bot-wall needed), and a
  `secret_key` fed from `SEARXNG_SECRET` (internal-only, low-stakes — it signs
  preference cookies on an unexposed instance; a fixed default, env-overridable).

### The sharing seam (single-tenant vs multi-tenant)

Each tenant is its own compose project (`PROJECT=baxter-<id>`) on its own network,
so an unprofiled service would give **each tenant its own** searxng (~20 containers).
But **SearXNG is stateless** — no per-tenant login, cookies, or secrets; it only
relays queries upstream. Unlike the browsers (per-tenant login state → must be
isolated) or the docker socket (root-equivalent → the real boundary), it carries
nothing tenant-specific, so it is **safe to share one instance** across tenants.

Two seams serve both cases, and both live in **core** (generic), while the actual
shared-instance wiring is **baxter-control's** job (keeping core clean):

- `SEARXNG_URL` — where the tool points. Default = the per-fleet
  `http://searxng:8080`. Multi-tenant sets it to a box-level shared instance.
- `SEARXNG_LOCAL ?= 1` (Makefile) — whether *this* fleet runs its own searxng.
  Core turns it on by default (single-tenant is always-on with zero config); the
  searxng service sits behind a `search` compose profile that the lifecycle targets
  activate when `SEARXNG_LOCAL=1`. Multi-tenant sets `SEARXNG_LOCAL=0` +
  `SEARXNG_URL=http://<shared>:8080`, so no redundant per-tenant container.

baxter-control follow-up (NOT built here): run one box-level searxng, set those two
vars per tenant.

### Docs / wiring

- `skills/web/SKILL.md` + the `runner-common` harness preamble currently say "search
  is disabled, open Bing in the browser" — update both to advertise the real
  `web-cli search <query>`.
- Leave the `claude` harness's native `WebSearch` untouched (it works); `web-cli
  search` is additionally available to every harness.
- `.env.example`: document `SEARXNG_URL` / `SEARXNG_LOCAL` / `SEARXNG_MAX_RESULTS`.

## Non-goals / accepted residuals

- No SSRF hardening beyond today's (fixed internal host; result URLs re-guarded on
  fetch).
- The internal `secret_key` is not a real secret (unexposed instance).
- SearXNG needs outbound internet to reach upstream engines; in a network-restricted
  sandbox, search degrades to a clear "no results / service" error, not a crash.
- Grants unchanged: `Bash(web-cli *)` already in `CORE_TOOLS`, `web` skill already
  staged — search just starts working.

## Test plan

- `web-cli.test.ts`: `formatSearchResults` (normal, empty results, answers,
  suggestions, missing fields, entity-decode, result cap); `performSearch` with an
  injected fetch stub (correct URL incl. `format=json` + encoding; HTTP-error path;
  non-JSON path). Keep the existing pure-helper tests.
- `make check` (tsc strict + `node --test`) green; `docker compose config -q` valid.
