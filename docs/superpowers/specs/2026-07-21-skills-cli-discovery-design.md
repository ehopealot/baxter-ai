# skills-cli — read-only discovery into the open agent-skills ecosystem

**Status:** draft spec v2 (not implemented — spec review folded in; awaiting TDD + operator sign-off)
**Date:** 2026-07-21

## Goal

Let Baxter **discover** skills from the open agent-skills ecosystem (`npx skills` /
[skills.sh](https://skills.sh), by vercel-labs) and **hand the operator what they
need to decide**, while the decision to actually **install** a skill stays a human,
curated, host-side action. No autonomous install, no new code-execution surface.

Trust model: "Discover + suggest (curated)". Refinement (operator, 2026-07-21):
for a match from a **non-trusted** owner, Baxter does not recommend it — he prints
the exact `npx skills add …` command for the operator to run at their own judgment.

## Why not the ecosystem's own flow

`find-skills` tells the agent to run `npx skills add <owner/repo@skill> -g -y` —
install globally, **skip confirmation**, any public GitHub repo. Two conflicts with
Baxter's model, sharp because **Baxter's inputs are attacker-influenced**:

1. **`npx` executes code** (arbitrary npm package + network). Baxter has no
   arbitrary execution — an execFile allowlist (no shell) and an offline
   (`network:none`) code sandbox.
2. **Installing a skill injects untrusted markdown into context.** Baxter's skills
   are *baked* (trusted, in the image) or *learned* (self-authored, staged by the
   trusted daemon with shadow-guards). An arbitrary third-party `SKILL.md`,
   installed unconfirmed from attacker-influenced input, is a persistent injection.

So we take only the **read half** (discovery) as a scoped CLI mirroring `data-cli`,
and leave the **write half** (install) to the operator.

## Design

### `skills-cli` (new scoped CLI — `app/scripts/skills-cli.mjs`)

Read-only gateway to the registry search API, `data-cli`/`web-cli` family.
**Surface is `find` only** — no `add`/`install`/`remove`/`use`/`sync`.

```
skills-cli find <query> [--owner <owner>] [--limit <n>]
```

- `GET https://skills.sh/api/search?q=<query>&limit=<n>[&owner=<owner>]` — the exact
  endpoint `npx skills find` uses (confirmed from vercel-labs/skills `src/find.ts`).
- **Host-locked** like `data-cli`, and structurally stronger: the path is a fixed
  `/api/search` and the run supplies only query **values** (`q`, `owner`, `limit`)
  via `URLSearchParams`, so there is no path-suffix surface at all. `buildSearchUrl`
  can't produce an off-origin URL; exported `assertConfined` (origin === base
  origin AND path === `/api/search`) is belt-and-suspenders and independently
  testable. Fast-fail hygiene rejects control chars / oversized query values.
- `--limit` is clamped to a ceiling (default 10, max 25) and rejects non-numeric /
  negative values — the byte cap shouldn't be the only bound.
- **Read-only, keyless.** Public search; no API key handled. GET only; a non-2xx or
  non-JSON body yields a clean error result, not a throw.
- **Response** (the CLI's shape): each hit `{ id, name, installs, source }`, mapped
  to `{ slug, name, installs, source, owner, repo, url, trusted }`:
  - `owner`/`repo` parsed from `source`, verbatim (see url-safety below);
  - `url` — a constructed `https://github.com/<owner>/<repo>` **only** when `source`
    matches a strict `owner/repo` shape (conservative charset, exactly two path
    segments, no `@`/`?`/`#`/userinfo/other host); otherwise the raw `source` is
    emitted under a `sourceRaw` field explicitly labeled unverified, and `url` is
    null. `source` is registry-response content = attacker-influenced, and `url` is
    the one field whose purpose is to be clicked by a human, so it must never be a
    naive concatenation. (TDD target.)
  - `trusted` — boolean: owner ∈ the trusted-owner allowlist (`vercel-labs`,
    `anthropics`, `anthropic`, `microsoft`, `vercel`; operator-extensible via env).
  - **Not sorted by installs.** Ordering is: trusted-owner first, then registry
    order; `installs` is returned as a field but is a *weak* signal (see below).
    Output is **untrusted content** (treat like `web-cli`): capped with a
    truncation marker, time-boxed by one `AbortController` over fetch + body read,
    metadata only — never a skill's `SKILL.md` body.
- Registry base overridable **by the operator** via `SKILLS_REGISTRY_BASE` (default
  `https://skills.sh`), **not by the run**:
  - claude harness: an env-prefixed invocation (`SKILLS_REGISTRY_BASE=… skills-cli
    …`) doesn't match the `Bash(skills-cli *)` allow-rule, so it's denied;
  - openrouter/local: `run_cli` is an execFile allowlist with no shell — there is
    no env-prefix form.
  - The override is **validated at startup** exactly like the recent
    `GMAIL_OAUTH_REDIRECT_BASE` hardening (commits 9dfb357/7caa893/7dfc0bf): parse
    with `new URL`, require http(s) + host + no path/query/userinfo, build from the
    parsed origin (not the raw string), reject junk loudly. (TDD target.)

### The `skill-discovery` skill (`app/skills/skill-discovery/SKILL.md`)

(Named `skill-discovery`, not `skills`, to avoid a `skills`/`skills-cli` readability
wart.) Adapts `find-skills` to the curated model. It tells Baxter:

- The ecosystem exists; search with `skills-cli find <query>` → metadata JSON.
- **Trust tiers drive behavior:**
  - **Trusted owner** (`trusted: true`) with reasonable adoption → Baxter may
    *recommend* it: surface `name`, `owner/repo` **verbatim**, install count, and
    the `url`, plus a one-line why, and offer to have the operator add it (giving
    the exact `npx skills add <owner/repo@skill>` command).
  - **Non-trusted owner** → Baxter does **not** endorse it. He prints the exact
    `npx skills add <owner/repo@skill>` command and says it's from an unverified
    owner and the operator's call — nothing more. (Operator refinement.)
- **Install counts are self-reported, unauthenticated telemetry — not
  Sybil-resistant.** Treat as a weak tiebreaker, never a trust signal; an attacker
  can inflate a count and squat a lookalike owner (`vercel-labs` vs `verceI-labs`),
  so **always show the exact owner/repo string** so lookalikes are visible. The
  strong signal is the trusted-owner allowlist; installs are the weak one.
- **Hard prohibition (closes the bypass in Security §1):** never `web-cli`/`WebFetch`
  an ecosystem skill's `SKILL.md`, and never copy/adapt ecosystem skill *content*
  into `learned-skills/` (or anywhere in the workspace). Discovery is metadata +
  a command for the operator, full stop. Baxter authors learned skills from his own
  reasoning, not by transcribing third-party skill files.

### Operator-curated install (host-side)

When the operator approves, they run `npx skills add <owner/repo@skill>` on the host
and **bake it**: land the vetted `SKILL.md` in `app/skills/<name>/`, wire it into the
surfaces' `SKILL_SRCS` in `grants.mjs`, commit, rebuild.

**Baked is the only landing spot for third-party skills (open Q1 resolved).** The
alternative — dropping it into the config volume's `learned-skills/` — is rejected:
`learned-skills/` is **run-writable and sync-staged**, so a later prompt-injected run
could silently edit or replace the "vetted" skill; the vetting wouldn't persist past
the next hostile run. Baked (in git, in `BAKED_SKILL_NAMES`, shadow-guarded) is the
only tier where "vetted" stays true. A `make add-skill REPO=… SKILL=…` convenience
for the baked path is a fast-follow, not blocking v1 (v1 documents the manual steps).

### Wiring

- `Bash(skills-cli *)` in `CORE_TOOLS` (`grants.mjs`) — read-only, harmless on every
  surface (voice-dispatch reuses `DISCORD_TOOLS`/`DISCORD_SKILL_SRCS`, so it's
  covered automatically).
- `skill-discovery` in each surface's `SKILL_SRCS` → auto-derives into
  `BAKED_SKILL_NAMES` (`grants.mjs`), so a learned skill can't shadow it.
- Dockerfile PATH shim for `skills-cli`.
- Brief capability bullet in the discord/email/heartbeat prompts + voice inline.

## Security posture (honest)

- **`skills-cli` adds no install *capability*.** It has no write/install verb. But
  this is NOT "the run cannot install a skill": the run already has web fetch +
  unscoped `Write` into its cwd (which contains `LEARNED_SKILLS_DIR`), and
  `ensureSkills` stages `learned-skills/*` into `.claude/skills` next run. So a
  prompt-injected run could fetch a third-party `SKILL.md` and transcribe it into a
  learned skill **without any install verb** — a path that *pre-exists* this
  feature (Baxter could always copy a web page into a learned skill). What this
  feature adds is **curated pointers to installable skill files**, i.e. the exact
  funnel an injected "find and set up the X skill" instruction would use. Gates:
  1. **discovery output is metadata-only** — no `SKILL.md` body enters context via
     `skills-cli`, so the *content* an injected run would transcribe still has to be
     fetched by a separate, visible `web-cli`/`WebFetch` call it must be talked into;
  2. **the skill explicitly prohibits** fetching/transcribing ecosystem skill
     content into the workspace (prompt-level — the honest tier for this residual,
     matching the repo's guardrail philosophy);
  3. **the operator can audit** — `learned-skills/` is the source of truth and
     sync-staged, so a rogue skill is one delete away; **and** (declined for v1, but
     named here for sign-off) the daemon could log newly-appeared learned-skill
     names so the operator sees them in `make logs`. Spec recommends deferring the
     daemon log to a fast-follow unless the operator wants it in v1.
- **No new code-exec.** No `npx`, no shell — a host-locked HTTP GET, same class as
  `web-cli`/`data-cli`.
- **Host-locked + encoded**, no path-suffix surface, no SSRF via the query. The
  query-as-exfil concern is moot: the run already reaches arbitrary URLs (same
  argument the repo makes for `WebFetch`), so a search query to a fixed host adds no
  exfil channel.
- **`url` is validated** from the attacker-influenced `source`, never naive concat.
- **Operator override validated** at startup (gmail-auth precedent).
- **Metadata residual:** names/owners are attacker-influenced text Baxter reads and
  may relay — same class as any `web-cli` fetch, already accepted; it can't act on
  its own (no install path in `skills-cli`).
- **Install trust persists only when baked** (Q1) — never demote a vetted
  third-party skill to the run-writable `learned-skills/` tier.

## TDD targets (tests written + reviewed before implementation)

Pure, security-critical, mirroring `data-cli.test.mjs`:

1. `buildSearchUrl({query, owner, limit})` — host-locked URL, `URLSearchParams`
   encoding; a query with `&`/`#`/`?`/spaces/unicode goes into `q`, not host/path/
   other params.
2. `assertConfined(url)` — origin always the registry base, path always
   `/api/search`; a crafted query can't move origin/path; a non-registry origin
   rejects (tested via the export, since the builder can't reach it).
3. `formatResults(json)` — maps `{id,name,installs,source}` → the enriched row;
   ordering is trusted-first (not installs-sorted); tolerates missing/malformed
   fields; caps output; sets `trusted` from the allowlist.
4. **`url` derivation safety** — malicious/odd `source` (extra segments, `@`/`?`/`#`,
   non-GitHub host, empty, unicode) never yields a constructed `github.com` URL;
   falls back to `sourceRaw` + null `url`; only a clean `owner/repo` yields a URL.
5. **Read-only surface + unknown-flag/verb rejection** — dispatch exposes only
   `find`; an `add`/`install`/unknown verb errors; an unknown `--flag` errors
   loudly (data-cli precedent) so a stray flag can't swallow a value or a future
   `--base` can't sneak in.
6. **`--limit` clamp** — clamps to the ceiling; rejects non-numeric/negative.
7. **`SKILLS_REGISTRY_BASE` validation** — garbage/non-https/path-bearing base
   rejected loudly; built from parsed origin (matches the `GMAIL_OAUTH_REDIRECT_BASE`
   tests).
8. Response cap + truncation marker; non-2xx / non-JSON body → clean error result.
9. **`grants.test.mjs`** gains: `skill-discovery` ∈ `BAKED_SKILL_NAMES` on every
   surface, and `Bash(skills-cli *)` in `CORE_TOOLS`.

Live/integration (post-approval, not unit): one real `skills-cli find` against
skills.sh to confirm the endpoint + shape.

## Open questions for the operator

1. **Daemon-side visibility of new learned skills** (the one residual from Security
   §1 that's an operator policy call): v1 relies on the skill's prohibition +
   audit-by-delete; do you want the daemon to also log newly-appeared
   `learned-skills/` names so they show up in `make logs`? (Lean: fast-follow, not
   v1.)
2. **Trusted-owner allowlist contents** — proposed `vercel-labs`, `vercel`,
   `anthropics`, `anthropic`, `microsoft`; env-extensible. Right set?
3. **`make add-skill` convenience** for the baked install path — v1 (documented
   manual steps) or fast-follow? (Lean: fast-follow.)

## Resolved (from spec review v1)
- Landing spot: **baked only** for third-party skills (trust asymmetry).
- `--limit`: **clamp** (default 10, max 25).
- Registry base: **const default + operator-only env override, validated** at
  startup.
- Installs downgraded to a **weak, non-trust** signal; trusted-owner allowlist is the
  strong signal; ordering is trusted-first, not installs-sorted.
