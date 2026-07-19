# data-cli — curated data-source gateway as a CLI (design)

Status: approved design, pending spec review.
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
  auth: null,                         // keyless; or { type: "query", param: "token", keyName: "FINNHUB_KEY" } — keyName indexes into data-keys.json
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
2. **Path sanitization (the one new must-do).** The path-join must refuse anything that would escape the fixed base host: reject a path containing a scheme (`http:`/`https:`/`//`), a leading `/` that would reset to host root outside the base, `..` traversal, or a backslash/control char — same spirit as `files-cli`/`projects-cli` confinement, but for URLs. Build the final URL from `new URL(base + "/" + cleanPath)` and assert the resolved `origin` + pathname prefix still match the registry `base` before fetching. Query params are values only (encoded), never able to inject a new host.
3. **Keys from a file, outside the run's reach.** API keys live in a secrets file under `~/.mail-agent/` (e.g. `data-keys.json`, `0600`), the same parent dir as the gmail/discord tokens — **outside** `MEMORY_DIR`, so a run's `files-cli`/`Read` can't enumerate or read them (same boundary as the tokens). `data-cli` reads the needed key at runtime and injects it per the source's `auth`. The run's env carries no key; it only gets `Bash(data-cli *)`.
4. **Responses are untrusted.** External API JSON is attacker-influenceable, treated like `web-cli`/`WebFetch` content (no special trust; Baxter is already primed for injection in fetched content). Response size is **capped** (configurable per source, sane default) so a huge/hostile payload can't flood the run.
5. **No secret in `data-cli` itself.** Like `web-cli`, the binary holds nothing; the secrets file is the only key store, and a keyless source needs no file at all.

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
- **Path sanitization** (the security core): rejects scheme-bearing paths (`http://`, `//host`), leading-slash host reset, `..` traversal, backslashes/control chars; accepts normal nested paths; asserts the resolved URL's origin+prefix still equals the registry base.
- **Request building**: path + `--query` params → correct final URL; keyless source → no auth added.
- **Key injection**: a **fake keyed source** + fake secrets → key lands in the right place (query param/header) and is sent only to the fixed host; missing key → clear error, no request.
- **Registry integrity**: every source has base/describe/hint; `list`/`describe` render.
- Live source calls (ESPN/Nominatim) verified by hand post-deploy, not in the suite (no network in tests).

## Non-goals (v1)

- No fixed intent enum, no forced output normalization (both were the "stiff" part).
- No finance/maps/news source onboarded (config-adds later; finance explicitly back-burnered).
- No caching/rate-limit *enforcement* engine (Nominatim's ~1 req/s is a documented courtesy in the skill; a code limiter can come with the first source that truly needs it).
- No write/POST APIs — read-only GET gateway.
