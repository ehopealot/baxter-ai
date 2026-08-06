# YouTube data-cli source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add YouTube Data API v3 as a keyed `data-cli` source, with the API key shared exactly like the Sendblue key (fleet-wide env var → materialized to the 0600 keys file → centrally stripped from runs).

**Architecture:** One registry entry in `data-sources.ts` (data-cli's keyed-source path is already built/tested). The key sharing adds two small pieces: a merge-preserving `syncDataKeysFromEnv` helper called once at the central `runAgent` spawn path, and `RUN_SECRET_ENV_VARS` derived from the registry key names so the strip can't be forgotten. Endpoint shapes stay in Baxter's learned `data-cli-youtube` skill (not baked).

**Tech Stack:** TypeScript (Node 22, `core/app/`), `node:test`. Spec: `docs/superpowers/specs/2026-08-06-youtube-data-cli-design.md`.

## Global Constraints

- All changes in the `core` submodule (`/app/core/app/`). Do NOT bump the outer `/app` pointer inside a task.
- Public, read-only YouTube; no OAuth, no transcripts. `data-cli`'s reader code is unchanged — the registry entry + env→file materialization + derived strip are the only code changes.
- `YOUTUBE_API_KEY` must be materialized to the 0600 `DATA_KEYS_PATH` (merge-preserving) and **never** present in a run's spawned env.
- The run-secret strip set is **derived from the registry key names**.
- Tests: `node --test` from `core/app/` + `./node_modules/.bin/tsc --noEmit`. `make` isn't installed — run those directly. Green + clean before each commit.
- Commit trailers (extra `-m`): `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01PUyyRqoP9fwkn8wyV42Bcc`. Do NOT push.

---

### Task 1: Registry entry + `syncDataKeysFromEnv` helper + docs

**Files:**
- Modify: `core/app/scripts/data-sources.ts`
- Create: `core/app/scripts/data-keys.ts`
- Create: `core/app/scripts/data-keys.test.ts`
- Modify: `core/app/scripts/data-cli.test.ts` (or `data-sources.test.ts` if that's where registry tests live — check)
- Modify: `core/app/.env.example`

**Interfaces:**
- Produces: `SOURCES.youtube`, the new `ROUTING` line, `DATA_SOURCE_KEY_NAMES: string[]` (from `data-sources.ts`), and `syncDataKeysFromEnv(env?, path?): void` (from `data-keys.ts`).

- [ ] **Step 1: Add the registry entry + derived key-name list to `data-sources.ts`.**

Add to `SOURCES`:
```ts
  youtube: {
    name: "youtube",
    base: "https://www.googleapis.com/youtube/v3",
    auth: { type: "query", param: "key", keyName: "YOUTUBE_API_KEY" },
    hint: "YouTube search + video/channel/playlist metadata & stats (Data API v3)",
    note: "quota ~10,000 units/day; search costs 100 units/call, most id-reads cost 1 — prefer id lookups over repeated search",
  },
```
Add to `ROUTING`: `["youtube videos / channels / playlists (search + stats)", "youtube"],`

Append the derived list (single source of truth for which env vars are data-source keys):
```ts
// The env-var names of every keyed source, derived from the registry. Used to (a)
// materialize these keys from the fleet env into the data-keys file and (b) strip
// them from every run's env (runtime.ts). Deriving it here means onboarding a keyed
// source can't forget either step.
export const DATA_SOURCE_KEY_NAMES: string[] = Object.values(SOURCES)
  .map((s) => s.auth?.keyName)
  .filter((n): n is string => Boolean(n));
```

- [ ] **Step 2: Write `data-keys.test.ts` (failing).**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncDataKeysFromEnv } from "./data-keys.ts";

test("merges YOUTUBE_API_KEY from env, preserving existing keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-"));
  try {
    const p = join(dir, "data-keys.json");
    writeFileSync(p, JSON.stringify({ OTHER_KEY: "keep" }));
    syncDataKeysFromEnv({ YOUTUBE_API_KEY: "AIzaXYZ" } as NodeJS.ProcessEnv, p);
    const out = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(out.YOUTUBE_API_KEY, "AIzaXYZ");
    assert.equal(out.OTHER_KEY, "keep");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no-op when the env var is unset — does not create the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-"));
  try {
    const p = join(dir, "data-keys.json");
    syncDataKeysFromEnv({} as NodeJS.ProcessEnv, p);
    assert.throws(() => statSync(p)); // file never created
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("creates the file 0600 when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-"));
  try {
    const p = join(dir, "data-keys.json");
    syncDataKeysFromEnv({ YOUTUBE_API_KEY: "k" } as NodeJS.ProcessEnv, p);
    assert.equal(statSync(p).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("idempotent: already-synced value doesn't rewrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-"));
  try {
    const p = join(dir, "data-keys.json");
    syncDataKeysFromEnv({ YOUTUBE_API_KEY: "k" } as NodeJS.ProcessEnv, p);
    const m1 = statSync(p).mtimeMs;
    syncDataKeysFromEnv({ YOUTUBE_API_KEY: "k" } as NodeJS.ProcessEnv, p);
    assert.equal(readFileSync(p, "utf8").includes("\"k\""), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 3: Run — expect failure** (`node --test scripts/data-keys.test.ts`).

- [ ] **Step 4: Implement `data-keys.ts`.**
```ts
// Materialize fleet-wide data-source API keys from the daemon env into the 0600
// keys file data-cli reads (data-cli has NO env fallback). MERGE-preserving so any
// baxter-control-provisioned keys survive; no-op when no relevant env var is set.
// The fleet-wide analog of sms-bot's Sendblue startup write — invoked once at the
// central runAgent spawn path (data-cli is granted on every surface).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DATA_KEYS_PATH } from "./paths.ts";
import { DATA_SOURCE_KEY_NAMES } from "./data-sources.ts";

export function syncDataKeysFromEnv(env: NodeJS.ProcessEnv = process.env, path: string = DATA_KEYS_PATH): void {
  const additions: Record<string, string> = {};
  for (const name of DATA_SOURCE_KEY_NAMES) { const v = env[name]; if (v) additions[name] = v; }
  if (Object.keys(additions).length === 0) return; // nothing set; never touch the file
  let current: Record<string, string> = {};
  try { current = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; } // surface a malformed file
  let changed = false;
  for (const [k, v] of Object.entries(additions)) if (current[k] !== v) { current[k] = v; changed = true; }
  if (!changed) return; // idempotent
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
  renameSync(tmp, path); // atomic; concurrent data-cli readers never see a half file
}
```

- [ ] **Step 5: Run `data-keys.test.ts` — PASS.**

- [ ] **Step 6: Registry test.** Find where SOURCES entries are asserted (there's a loop asserting each source's shape + keyed sources have a keyName in `data-cli.test.ts` ~line 275). Confirm `youtube` passes it. Add one focused case (in `data-cli.test.ts`): with a keys map `{ YOUTUBE_API_KEY: "SECRET123" }`, `performRequest(SOURCES.youtube, "search", [["q","cats"],["part","snippet"]], ...)` (reuse the fake-fetch harness the existing keyed tests use) sends `key=SECRET123` to `www.googleapis.com` and scrubs `SECRET123` from `finalUrl`/`text`. Also assert `DATA_SOURCE_KEY_NAMES` includes `"YOUTUBE_API_KEY"`.

- [ ] **Step 7: `.env.example`.** Document `YOUTUBE_API_KEY` in `core/app/.env.example` beside `SENDBLUE_*` — fleet-wide, optional; when set it enables the `youtube` data source; obtain from Google Cloud with "YouTube Data API v3" enabled. Match the surrounding comment style.

- [ ] **Step 8: Full suite + typecheck; commit.** (`feat(data-cli): YouTube Data API source + env→keys-file materialization`)

---

### Task 2: Runtime wiring (derived strip + guarded materialization)

**Files:**
- Modify: `core/app/scripts/runtime.ts`
- Modify: `core/app/scripts/runtime.test.ts` and/or `core/app/scripts/run-env.test.ts`

**Interfaces:** Consumes `DATA_SOURCE_KEY_NAMES` (data-sources.ts) and `syncDataKeysFromEnv` (data-keys.ts) from Task 1.

- [ ] **Step 1: Derive the strip set.** In `runtime.ts`, import `DATA_SOURCE_KEY_NAMES` from `./data-sources.ts` and append it to `RUN_SECRET_ENV_VARS`:
```ts
export const RUN_SECRET_ENV_VARS = [
  "AGENTMAIL_API_KEY",
  "DISCORD_BOT_TOKEN",
  "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER",
  // Keyed data-cli source keys (e.g. YOUTUBE_API_KEY): the run reaches them only
  // via data-cli reading the 0600 DATA_KEYS_PATH, never its env. Derived from the
  // registry so onboarding a keyed source can't forget the strip.
  ...DATA_SOURCE_KEY_NAMES,
];
```

- [ ] **Step 2: Materialize once at the spawn chokepoint.** Add a module-level guard and call `syncDataKeysFromEnv` in `runAgent` before the strip:
```ts
import { syncDataKeysFromEnv } from "./data-keys.ts";
let dataKeysSynced = false;
```
Inside `runAgent`, before the `spawn(...)` (near where `runEnv` is finalized):
```ts
// Materialize fleet-wide data-source keys (YOUTUBE_API_KEY, …) from the daemon env
// into the 0600 keys file once per process; the strip below then keeps them out of
// the run's env. Guard-then-try so a write failure can't re-enter or crash the run.
if (!dataKeysSynced) { dataKeysSynced = true; try { syncDataKeysFromEnv(runEnv); } catch (err) { logErr(`data-keys sync failed (${(err as Error).message})`); } }
```
(Use `runEnv` — the daemon env pre-strip — and `logErr`, already used in this file.)

- [ ] **Step 3: Tests.**
  - Extend the strip test (`run-env.test.ts`/`runtime.test.ts`): `stripRunSecrets({ ...env, YOUTUBE_API_KEY: "k" })` has no `YOUTUBE_API_KEY` (mirror the existing SENDBLUE/AGENTMAIL assertions).
  - A `runAgent` case (mirror the existing central-strip runAgent test): pass an injected harness + `env` including `YOUTUBE_API_KEY`, and assert the env the harness/child receives has it removed. If the existing test captures the spawned env, extend it; otherwise assert via `stripRunSecrets` directly (the strip is what the child gets).
  - Note: because materialization is guarded once-per-process, don't rely on it in a runAgent test — test `syncDataKeysFromEnv` directly (Task 1) and the strip here.

- [ ] **Step 4: Full suite + typecheck; commit.** (`feat(runtime): strip + materialize data-cli source keys (YouTube)`)

---

## Self-review notes

- **Spec coverage:** registry+routing+hint (T1); env→file materialization (T1 helper + T2 wiring); derived central strip (T2); docs (T1 .env.example); learned skill = no code (Baxter authors at runtime). ✅
- **Type consistency:** `DATA_SOURCE_KEY_NAMES` and `syncDataKeysFromEnv` produced in T1, consumed in T2. `data-sources.ts` imports nothing, so `runtime.ts`/`data-keys.ts` importing from it is cycle-free (data-keys.ts also imports paths.ts; runtime.ts already imports paths.ts). ✅
- **Security:** key never in a run's env (derived strip); file is 0600, merge-preserving, atomic write; data-cli host-locks + scrubs + redirect:manual (unchanged). ✅
- **Deploy (operator):** set `YOUTUBE_API_KEY` in `app/.env`, rebuild+redeploy container, bump `/app` pointer (coordinator). First use: `data-cli describe youtube` → Baxter writes the learned skill.
