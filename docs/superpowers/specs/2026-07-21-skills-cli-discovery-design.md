# skills-cli — read-only discovery into the open agent-skills ecosystem

**Status:** draft spec (not yet implemented — awaiting review + operator sign-off)
**Date:** 2026-07-21

## Goal

Let Baxter **discover** skills from the open agent-skills ecosystem (`npx skills` /
[skills.sh](https://skills.sh), by vercel-labs) and **suggest** good ones to the
operator — while the decision to actually **install** a skill stays a human,
curated, host-side action. No autonomous install, no new code-execution surface.

This is the "Discover + suggest (curated)" trust model chosen for the integration.

## Why not the ecosystem's own flow

The ecosystem's `find-skills` skill tells the agent to run
`npx skills add <owner/repo@skill> -g -y` — install globally, **skip confirmation**,
any public GitHub repo. Two hard conflicts with Baxter's security model, both
sharp because **Baxter's inputs are attacker-influenced** (Discord/web content):

1. **`npx` executes code.** `npx skills` downloads and runs an npm package with
   network access. Baxter has *no* arbitrary execution — a structured-tool
   execFile allowlist (no shell) and an **offline** (`network:none`) code sandbox.
   Handing the run `npx` is a large new execution surface.
2. **Installing a skill injects untrusted markdown into context.** Baxter's skills
   are *baked* (trusted, in the image) or *learned* (ones he authors himself,
   staged by the trusted daemon with shadow-guards). An arbitrary third-party
   `SKILL.md` from attacker-influenced input, installed with no confirmation, is a
   persistent prompt-injection vector.

So we take only the **read half** of the ecosystem (discovery), as a first-class
scoped CLI — mirroring how `data-cli` is a read-only, host-locked gateway to
curated sources — and leave the **write half** (install) to the operator.

## Design

### `skills-cli` (new scoped CLI — `app/scripts/skills-cli.mjs`)

A read-only gateway to the skills registry's search API, in the same family as
`data-cli`/`web-cli`. **Command surface is deliberately `find` only** — there is
**no** `add`/`install`/`remove`/`use`/`sync` verb. Discovery is structural, not a
prompt promise: the run *cannot* install a skill because the code to do so isn't
there.

```
skills-cli find <query> [--owner <owner>] [--limit <n>]
```

- Issues `GET https://skills.sh/api/search?q=<query>&limit=<n>[&owner=<owner>]`
  (the exact endpoint `npx skills find` uses; confirmed from `src/find.ts`).
- **Host-locked** like `data-cli`: the base (`https://skills.sh`) is a fixed
  const; the run supplies only the *query values* (`q`, `owner`, `limit`), which
  are `URLSearchParams`-encoded — it never supplies host, path, or scheme. A
  `buildSearchUrl()` + `assertConfined()` pair guarantees the resolved origin is
  always the registry's and the path is always `/api/search` (reject-list for
  control chars / oversized params as fast-fail hygiene).
- **Read-only, keyless.** The registry search is public; no API key is handled
  (unlike some data-cli sources). GET only; a non-2xx or non-JSON body surfaces a
  clean error, not a crash.
- **Response** (per the CLI's own shape): each hit is `{ id, name, installs,
  source }`. `skills-cli` maps to `{ slug, name, installs, source, url }` where
  `url` is the GitHub/source URL derived from `source` (so the operator can vet
  the real repo before installing). Sorted by `installs` desc (most-adopted
  first). Output is **untrusted content** (treat like `web-cli`): capped at a byte
  limit with a truncation marker, time-boxed by a single `AbortController` over
  fetch + body read. It returns **metadata only** — never a skill's full
  `SKILL.md` body — so no third-party skill text enters Baxter's context via
  discovery.
- Registry base overridable by an **operator** env var (e.g.
  `SKILLS_REGISTRY_BASE`) for testing, **not** by the run (the run's env is
  controlled by the daemon). Default `https://skills.sh`.

### The `skills` skill (`app/skills/skills/SKILL.md`)

An adaptation of `find-skills` for the curated model. It tells Baxter:

- The open ecosystem exists; browse at skills.sh.
- To search: `skills-cli find <query>` → JSON of `{slug, name, installs, source, url}`.
- **Trust ranking** (from the ecosystem's own guidance): prefer high install counts
  (1K+), official owners (`vercel-labs`, `anthropics`, `microsoft`), be skeptical
  of very low adoption. (Note: the search API returns `installs` but not GitHub
  stars, so ranking is installs + owner reputation; the `url` lets a human check
  stars.)
- **Suggest, don't install.** Surface the best match(es) to the operator with the
  metadata + a one-line why, and ask whether to add it. Baxter *cannot* install
  (no verb) and must not imply he did. Installing is the operator's call.

### Operator-curated install (host-side, out of the run's reach)

When the operator approves a suggestion, they install it on the host with the real
ecosystem tool. **Open sub-decision (for review):** where the vetted skill lands —

- **(A) Baked** — `npx skills add <repo@skill>` into `app/skills/<name>/`, wire it
  into the surfaces' `SKILL_SRCS` in `grants.mjs`, rebuild. Permanent, trusted,
  versioned in git. Heaviest.
- **(B) Learned-skills volume** — drop the vetted `SKILL.md` into the config
  volume's `learned-skills/<name>/` on the box; `ensureSkills` stages it next run
  (shadow-guard applies). No rebuild; lives with Baxter's own learned skills.
  Lighter, but not in git.

Recommendation: document both; provide a small `make add-skill REPO=… SKILL=…`
convenience for (A) as a fast-follow, not blocking v1. v1 can simply document the
manual steps.

### Wiring

- `Bash(skills-cli *)` added to `CORE_TOOLS` in `grants.mjs` (all surfaces — it's
  read-only and harmless everywhere).
- `skills` added to each surface's `SKILL_SRCS` → falls into `BAKED_SKILL_NAMES`
  (so a learned skill can't shadow it; `grants.test.mjs` asserts the union).
- Dockerfile PATH shim for `skills-cli` (after the other CLI shims).
- Capability bullet in the discord/email/heartbeat prompts + voice inline (brief:
  "discover ecosystem skills with `skills-cli find`; suggest good ones, don't
  install").

## Security posture (summary)

- **No install, structurally.** `skills-cli` has no write/install verb; the run
  literally cannot add a skill. The third-party-markdown-into-context injection
  vector is gated behind human review, on the host, before any skill reaches
  Baxter's skills dir.
- **No new code-exec.** No `npx`, no shell; a plain host-locked HTTP GET, same
  class as `web-cli`/`data-cli` (capabilities Baxter already has).
- **Host-locked + encoded.** Query values are the only run-supplied input, encoded
  via `URLSearchParams`; the origin is asserted to be the registry's.
- **Untrusted output**, capped + time-boxed; metadata only, no skill bodies.
- **Read-half only** of the ecosystem — the write half stays operator-curated.

Residual: the search *metadata* (names/owners) is attacker-influenceable content
Baxter reads and may relay to the operator — same class as any `web-cli` fetch,
treated as untrusted; it can't act on its own since there's no install path.

## TDD targets (tests written + reviewed before implementation)

Pure, security-critical pieces, mirroring `data-cli.test.mjs`:

1. `buildSearchUrl({query, owner, limit})` — correct host-locked URL, params
   `URLSearchParams`-encoded; a query containing `&`/`#`/`?`/spaces/unicode is
   encoded into `q`, not injected into host/path/other params.
2. `assertConfined(url)` — origin is always the registry base; a crafted query
   can't move the origin or the `/api/search` path; rejects a non-registry origin.
3. `formatResults(json)` — maps `{id,name,installs,source}` → `{slug,name,installs,
   source,url}`; derives the source URL; sorts by installs desc; tolerates missing/
   malformed fields; caps output.
4. **Read-only surface** — `parseArgs`/dispatch expose only `find`; an `add`/
   `install`/unknown verb errors (asserts the install path does not exist).
5. Response cap + truncation marker; a non-2xx / non-JSON body yields a clean
   error result, not a throw.

Live/integration (post-approval, not unit): one real `skills-cli find` against
skills.sh to confirm the endpoint + shape still hold.

## Open questions for review

1. Install landing spot: baked (A) vs learned-skills volume (B) vs both. (Lean:
   document both; `make add-skill` for A as fast-follow.)
2. Should `skills-cli find` also expose an `--limit` cap ceiling (e.g. max 25) so a
   run can't request an enormous list? (Lean: yes, clamp.)
3. Is `skills.sh/api/search` stable enough to host-lock against, or should the base
   be an operator env with a documented default? (Lean: const default +
   operator-only env override.)
