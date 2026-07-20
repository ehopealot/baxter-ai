# data-cli — curated data-source gateway as a CLI (design)

Status: approved design; spec-review findings folded in (redirect lock, Read-residual honesty, key scrubbing, pinned URL check, timeout/non-2xx, header auth). Implementing.
Related: [[web-cli-design]] (closest analog — keyless fetch boundary), `scripts/gmail.mjs` (credential-from-file + fixed-recipient security pattern), `scripts/grants.mjs` (shared-core grant), `scripts/projects-cli.mjs` (path-confinement pattern).

## Goal

Give Baxter a small, curated set of **preferred data sources** for real-world queries (scores, geocoding/places, and — later — finance, news, maps, etc.) without him relearning each API's shape every time, and without exposing API keys to the model.

The insight that shaped this: an LLM reads JSON fine and composes queries well. What it *can't* safely do itself is (a) hold a keyed API's secret, and (b) reliably pick a good source. So the wrapper curates **sources** (few, stable), not **intents** (many, open-ended) — a fixed enum of intents would be stiff and box Baxter in the moment a query doesn't match a pre-made one. Baxter keeps full flexibility to compose queries *within* a curated source; the CLI supplies the auth and the guardrails.

## CLI

The subcommand is a **source name**; Baxter supplies the path + query params:

```
data-cli <source> <path> [--query k=v ...] [--format json|text]
data-cli list                 # sources + routing hints ("scores → espn, geocoding → nominatim")
data-cli describe <source>    # base URL, auth, endpoint patterns, worked examples
```

Examples:
```
data-cli espn basketball/nba/scoreboard
data-cli espn baseball/mlb/teams/25
data-cli nominatim search --query q="Powell's Books, Portland" --query format=json
```

- `list`/`describe` are the **learn-once** mechanism — Baxter discovers the interface and each source's shape at runtime, so the skill stays thin and adding a source needs no reteaching. `list` also carries the "preferred source for X" routing hints, which is where the original "preferred sources per query type" goal lives — as guidance, not rigid commands.
- Default output is the source's JSON (optionally capped — see Security); `--format text` is a light human-readable rendering where it helps.
- `--query k=v` (repeatable) builds the query string; positional `<path>` is the endpoint path under the source's fixed base.
- If Baxter works out a good query pattern for a source, the existing **learned-skills** mechanism lets him crystallize it into a reusable skill across all surfaces — flexibility now, shortcut later, no code from us.

## Registry (config-as-code)

Sources live in one registry module (`scripts/data-sources.mjs`). Each source is a small object:

```js
{
  name: "espn",
  base: "https://site.api.espn.com/apis/site/v2/sports",
  auth: null,                         // keyless; or query-auth { type: "query", param: "token", keyName: "FINNHUB_KEY" };
                                      // or header-auth { type: "header", name: "X-Api-Key", keyName: "..." }. keyName indexes into data-keys.json
  describe: "ESPN scores/schedules ... endpoint patterns + examples",
  hint: "scores, schedules, standings for major US leagues",
  // optional: cap, default query params, a light transform(json) if a source really needs one
}
```

- **Not** a JSONPath/normalization DSL — sports/geo responses resist a uniform field map, and Baxter handles raw JSON well. A source *may* carry an optional `transform(json)` for the rare case that needs trimming, but the default is pass-through JSON.
- Adding a source = one registry entry (+ a `describe` blurb). No new binary/skill/grant/shim. Adding a **keyed** source additionally = a key in the secrets file.
- `type → preferred source` routing hints are data in the registry, surfaced by `list`.

## Security (the crux)

Mirrors `gmail.mjs`'s "the model can't control the dangerous part" philosophy.

1. **Host is fixed per source; the model never controls it.** The registry owns each source's `base` (scheme + host + root path). Baxter supplies only the path suffix + query params. So a keyed source's key can only ever be sent to that source's real host — it cannot be redirected to an attacker's server.
2. **Path sanitization — pinned check (the one new must-do).** The path-join must refuse anything that would escape the fixed base host. Reject-list (fast-fail hygiene): a raw positional path containing a scheme (`http:`/`https:`/`//`), a leading `/`, a backslash or control char, a literal `..`, or a `?`/`#`/`%` (query and fragment must come through `--query`, not be smuggled into the path; `%` blocks percent-encoded traversal like `%2e%2e` that `new URL()` would silently normalize to real dot-dot). **The load-bearing check is the post-resolution assert, not the reject-list.** Build the final URL by string concatenation — `new URL(base + "/" + cleanPath)` — never the two-arg `new URL(path, base)` resolution form (which resolves a leading `/` or `//host` *against* `base` and escapes it). Then assert, authoritatively: `url.origin === baseOrigin && (url.pathname === basePath || url.pathname.startsWith(basePath + "/"))` — the trailing-slash guard stops `/apis/site/v2/sportsfoo` sneaking past a bare prefix match. Query params are appended as encoded values only, never able to inject a new host.
3. **Redirects do NOT follow for keyed sources (the host-lock's real teeth).** A 3xx on a keyed source (fetch `redirect: "manual"`) is NOT followed and is surfaced as a **refused-redirect error** — otherwise an open-redirect (or a compromised/changed API) would carry a query-param token cross-origin, defeating claim #1 (undici strips `Authorization` *headers* on cross-origin redirects, but a query-string token gets no such protection). Note: manual mode yields an opaque-redirect response (status `0`, headers stripped), so the CLI **cannot** surface the `Location` — the model just retries the canonical endpoint. Keyless sources may follow, but re-assert `url.origin === baseOrigin` on the final URL after the fetch (web-cli's post-redirect check only rejects internal hosts — that is NOT enough here).
4. **Keys from a file — honest boundary (matches the repo's stance).** API keys live in a secrets file under `~/.mail-agent/` (e.g. `data-keys.json`, `0600`), the same parent dir as the gmail/discord tokens — **outside** `MEMORY_DIR`. This means `files-cli` (workspace-confined) can't *enumerate or discover* it, the run's env carries no key, and the binary embeds nothing. It does **not** mean the key is model-unreachable: exactly as `app/CLAUDE.md` documents for `discord-token.json`, the native `Read` grant in `CORE_TOOLS` is not cwd-bounded under the claude harness, so a prompt-injected run that knows the exact path could `Read` the file (0600 doesn't stop the same UID). This is the **same accepted residual as the existing tokens** — under the openrouter/local harnesses reads *are* cwd-confined, so the exposure is harness-dependent. Onboard only keys whose blast radius fits that residual.
5. **Key never leaks through data-cli's own output.** Because a query-param token rides in the request URL, `data-cli` must (a) never print the final URL for a keyed source (or print it with the auth param elided), and (b) scrub the literal key value out of any emitted body/error before writing it (`body.split(key).join("[key]")`), since APIs commonly echo the request URL in error JSON. Without this, claim #6 ("no secret transits into the run") is false — the secret passes *through* data-cli and could surface on stdout.
6. **Responses are untrusted, capped, and time-boxed.** External API JSON is attacker-influenceable, treated like `web-cli`/`WebFetch` content (no special trust; Baxter is already primed for injection in fetched content). Response size is **capped** (configurable per source, sane default) with an explicit `[truncated]` marker so the model doesn't silently mis-parse a cut-off JSON body. A single `AbortController` timer covers **both** the fetch and the body read (mirrors `web-cli`'s `httpGet`/`readCapped` — a dribbling server otherwise stalls to the 120s harness kill). A non-2xx is surfaced as status + the capped, key-scrubbed body, not thrown away.
7. **No secret in `data-cli` itself.** Like `web-cli`, the binary holds nothing; the secrets file is the only key store, and a keyless source needs no file at all.

## Seed sources (v1)

| Source | Use | Key? | Notes |
|---|---|---|---|
| `espn` | scores, schedules, standings | keyless | `site.api.espn.com/apis/site/v2/sports`; `{sport}/{league}/scoreboard`, `/teams/{id}`. Unofficial/undocumented — accepted fragility; a break is a one-line registry fix. |
| `nominatim` | geocoding, place lookup | keyless | OpenStreetMap; requires a descriptive `User-Agent` per their usage policy (set by the CLI); respect ~1 req/s. |

Both keyless, so **v1 needs no sign-up.** The key-injection path is still built and **tested against a fake keyed source** so the first real keyed source is pure config.

### How a keyed source plugs in later (worked example, not built in v1)

Finance is back-burnered, but to prove the foundation: adding Finnhub later =
1. registry entry `{ name: "finnhub", base: "https://finnhub.io/api/v1", auth: { type: "query", param: "token", keyName: "FINNHUB_KEY" }, describe: "...", hint: "stock quotes" }`;
2. drop `{ "FINNHUB_KEY": "..." }` into `~/.mail-agent/data-keys.json`.
No code, no new grant, no redeploy-of-new-binary — just config + secret.

## Wiring

- `Bash(data-cli *)` added to `grants.mjs`'s `CORE_TOOLS` (all surfaces).
- A `data` skill (`skills/data/SKILL.md`) — thin; points at `list`/`describe`, states the routing hints and the "compose within a source, don't relearn per query" model, and the write-nothing-secret reminder. Added to each surface's `SKILL_SRCS` → `BAKED_SKILL_NAMES`.
- PATH shim in `app/Dockerfile` (`data-cli` → `node /app/scripts/data-cli.mjs`).
- Secrets path centralized in `scripts/paths.mjs` (`DATA_KEYS_PATH` under the state dir).
- `app/CLAUDE.md` boundary-CLI section gets a `data-cli` paragraph.
- A brief mention/pointer in each prompt's capability list (like the projects-cli bullet).

## Testing

`node:test` (`scripts/data-cli.test.mjs`), pure logic, no network:
- **Path sanitization** (the security core): rejects scheme-bearing paths (`http://`, `//host`), leading-slash host reset, `..` traversal, **percent-encoded traversal (`%2e%2e/`)**, `?`/`#` in the path, backslashes/control chars, and a same-host prefix-escape (`…/sportsfoo` vs base `…/sports`); accepts normal nested paths; asserts the resolved URL's `origin` + pathname prefix (with the trailing-slash guard) still equals the registry base.
- **Request building**: path + `--query` params → correct final URL; keyless source → no auth added.
- **Key injection**: a **fake keyed source** + fake secrets → key lands in the right place for **both** `query` and `header` auth, and is sent only to the fixed host; missing key → clear error, no request; the key value never appears in printed output (scrub check).
- **Redirect lock**: a fake keyed source whose (stubbed) fetch returns an opaque-redirect → data-cli does NOT issue a second request / does NOT emit the key; raises a refused-redirect error instead.
- **Registry integrity**: every source has base/describe/hint; `list`/`describe` render.
- Live source calls (ESPN/Nominatim) verified by hand post-deploy, not in the suite (no network in tests).

## Non-goals (v1)

- No fixed intent enum, no forced output normalization (both were the "stiff" part).
- No finance/maps/news source onboarded (config-adds later; finance explicitly back-burnered).
- No caching/rate-limit *enforcement* engine (Nominatim's ~1 req/s is a documented courtesy in the skill; a code limiter can come with the first source that truly needs it).
- No write/POST APIs — read-only GET gateway.
