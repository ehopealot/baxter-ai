# YouTube (Data API v3) as a data-cli source

**Date:** 2026-08-06
**Status:** Approved (design); pending implementation plan

## Goal

Let Baxter reach the **YouTube Data API v3** through the existing `data-cli`
gateway — public, read-only lookups: search, and video/channel/playlist
metadata & stats. The API key is shared **the same way the Sendblue key is**: a
fleet-wide env var, materialized into the 0600 keys file for the CLI and
centrally stripped from every run's env.

## Scope

- **In:** `search`, `videos`, `channels`, `playlists`, `playlistItems`,
  `videoCategories`, and other public read endpoints of Data API v3 — reached via
  a single API key.
- **Out:** video **transcripts/captions text** (not available with an API key —
  needs OAuth + ownership), and any **account-specific / write** operations
  (rating, playlist management, subscriptions) — those need OAuth, which
  `data-cli` deliberately does not do. This source is public-read-only.

## Background

`data-cli` (`docs/superpowers/specs/2026-07-19-data-cli-design.md`) is a curated,
host-locked gateway. The registry (`data-sources.ts`) owns only the
trust-critical bits (host + auth/key + a routing hint); each source's endpoint
*shape* lives in a **learned** skill Baxter researches and maintains
(`data-cli-<name>`), not baked config. v1 shipped two keyless sources; the
key-injection path is built and tested against a fake keyed source, so YouTube
is the first real keyed source — "pure config" on the data-cli side.

Keys are read from `DATA_KEYS_PATH` (`~/.mail-agent/data-keys.json`, 0600) by
`data-cli`'s `loadKeys` — **file only, no env fallback**. So for a run to use a
keyed source, the key must be in that file, and the key must be kept out of the
run's env (or the agent could echo it). That is exactly the Sendblue posture.

**The Sendblue model (mirrored here):** `SENDBLUE_*` are fleet-wide container env
vars declared in `core/app/.env.example`; `sms-bot.ts` writes them 0600 to
`SMS_KEYS_PATH` for `sms-cli`; and `runtime.ts`'s `RUN_SECRET_ENV_VARS` /
`stripRunSecrets` (applied in the single `runAgent` spawn path all daemons go
through) removes them from every run's env.

## Design

### 1. Registry entry (`scripts/data-sources.ts`)

```ts
youtube: {
  name: "youtube",
  base: "https://www.googleapis.com/youtube/v3",
  auth: { type: "query", param: "key", keyName: "YOUTUBE_API_KEY" },
  hint: "YouTube search + video/channel/playlist metadata & stats (Data API v3)",
  note: "quota ~10,000 units/day; search costs 100 units/call, most id-reads cost 1 — prefer id lookups over repeated search",
},
```
Plus a `ROUTING` line: `["youtube videos / channels / playlists (search + stats)", "youtube"]`.

data-cli's existing keyed-source posture applies unchanged: `base` host-locks the
key to `www.googleapis.com`; keyed sources use `redirect:"manual"` (no
cross-origin key leak on a 3xx); the key value (raw + URL-encoded forms) is
scrubbed from all emitted output and the `key=` param is structurally redacted.

### 2. Key sharing — the Sendblue pattern, fleet-wide

`YOUTUBE_API_KEY` is a **fleet-wide container env var** (documented in
`core/app/.env.example` beside `SENDBLUE_*`; flows in via compose `env_file`).

Two mechanisms make it usable by `data-cli` while invisible to the run:

- **Materialize env → keys file.** A small, tested helper merges any
  registry-declared key present in the daemon env into `DATA_KEYS_PATH`:
  ```ts
  // data-sources.ts (single source of truth for which env vars are data keys)
  export const DATA_SOURCE_KEY_NAMES: string[] =
    Object.values(SOURCES).filter(s => s.auth).map(s => s.auth!.keyName); // ["YOUTUBE_API_KEY"]

  // new: syncDataKeysFromEnv(env = process.env, path = DATA_KEYS_PATH): void
  //   read existing file (or {}), for each name in DATA_SOURCE_KEY_NAMES with a
  //   non-empty env value set file[name]=value, write atomically 0600 — MERGE, so
  //   any baxter-control-provisioned keys are preserved. No-op if none present.
  ```
  Called **once per process, guarded**, at the central `runAgent` chokepoint
  (`runtime.ts`), right before the strip — the fleet-wide analog of `sms-bot`'s
  startup write (data-cli is granted on every surface, so materialization belongs
  at the shared spawn path, not in one daemon). The write is synchronous +
  guarded so concurrent runs in a process can't race it.

- **Central strip, derived from the registry.** `RUN_SECRET_ENV_VARS` gains the
  registry key names, so `stripRunSecrets` removes them from every run's env:
  ```ts
  export const RUN_SECRET_ENV_VARS = [
    "AGENTMAIL_API_KEY", "DISCORD_BOT_TOKEN",
    "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER",
    ...DATA_SOURCE_KEY_NAMES, // youtube + any future keyed source, automatically
  ];
  ```
  **Deriving the strip set from the registry is the safety invariant:** a future
  keyed source can't be onboarded without its key being stripped from runs (a
  forgotten strip = key leak to the agent). `runtime.ts` importing the const from
  `data-sources.ts` is a clean dependency (the registry module imports nothing).

Result: the daemon env holds `YOUTUBE_API_KEY`; `runAgent` writes it to the 0600
`DATA_KEYS_PATH` once, then hands the run an env with it stripped; `data-cli`
(spawned by the run, inheriting the stripped env) reads it from the file only.
The agent can use YouTube but can never read the raw key.

### 3. Endpoint knowledge stays learned

No baked endpoint skill. `data-cli describe youtube` already bootstraps Baxter
writing/maintaining the `data-cli-youtube` learned skill (paths, params,
examples) — self-healing and verified live, per the data-cli design. The registry
`hint`/`note` are the only baked editorial bits.

### 4. Provisioning / docs

- `core/app/.env.example`: document `YOUTUBE_API_KEY` (fleet-wide, optional —
  when set, enables the `youtube` data source; get it from Google Cloud with
  "YouTube Data API v3" enabled). Same section/style as `SENDBLUE_*`.
- No new grant/shim/skill/binary — `data-cli` is already a shared-core tool.

## Testing

- `data-sources.test.ts` (or `data-cli.test.ts`): the `youtube` entry builds the
  expected URL (`.../youtube/v3/<path>?...&key=<key>`), the key is injected from
  the file and scrubbed from output (reuse the existing keyed-source test harness;
  add a youtube-shaped case); `DATA_SOURCE_KEY_NAMES` contains `YOUTUBE_API_KEY`.
- New helper test for `syncDataKeysFromEnv`: merges `YOUTUBE_API_KEY` from env
  into a temp keys file **preserving** a pre-existing unrelated key; no-op when
  the env var is unset/empty; writes mode `0600`; idempotent.
- `runtime.test.ts` / `run-env.test.ts`: `stripRunSecrets` removes
  `YOUTUBE_API_KEY` (via the derived list); a `runAgent` case asserting the
  spawned env has no `YOUTUBE_API_KEY` (mirror the existing Sendblue/agentmail
  strip tests).

## Global constraints

- Public, read-only; no OAuth, no transcripts/captions text, no write ops.
- `YOUTUBE_API_KEY` is a fleet-wide env var, materialized to the 0600
  `DATA_KEYS_PATH` (merge-preserving) and **never** present in a run's env.
- The run-secret strip set is **derived from the registry key names** — onboarding
  a keyed source auto-strips its key.
- Endpoint shapes stay in the learned `data-cli-youtube` skill, not baked.
- No new grant/shim/binary; `data-cli` reader code is unchanged (registry + the
  env→file materialization + the derived strip are the only code changes).

## Deploy (operator, post-merge)

Set `YOUTUBE_API_KEY` in the box's `app/.env` (fleet-wide, like `SENDBLUE_*`),
then rebuild+redeploy the container. On first use `data-cli describe youtube`
prompts Baxter to write the `data-cli-youtube` learned skill.
