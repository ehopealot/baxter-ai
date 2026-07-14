# Baxter Code Execution via Piston — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Baxter offline Python/Node code execution in an isolated Piston sandbox, reached only through a scoped `code-cli`, with a curated set of pre-installed libraries.

**Architecture:** A stock Piston container runs as a standing service on a shared docker network (`<project>-net`); a provisioning step installs the Python/Node runtimes and libs into it. The spawned `claude -p` run reaches it via `code-cli` (a token-less boundary CLI, raw `fetch` → Piston's REST API), mirroring the `gmail.mjs`/`discord-cli` pattern. Execution is offline and its resource maxima are pinned in Piston's own config.

**Tech Stack:** Node 22 (ESM), `ghcr.io/engineer-man/piston`, Piston REST API v2, Docker (network + named volume), `node:test`.

## Global Constraints

- **Piston image:** `ghcr.io/engineer-man/piston` (latest), run `--privileged` (its `isolate` sandbox requires it), on a **user-defined** docker network `<project>-net` (user-defined → DNS name resolution, so the app container can reach `piston` by name). Packages persist in a named volume `<project>-piston` mounted at `/piston/packages`.
- **`PROJECT := $(notdir $(CURDIR))`** (existing Makefile line 1) — so all names are `<project>-*`. Every `make` target for this feature must be run from the same directory as `run`/`discord` so they share the network. (In the dev container that's `app-*`; on the operator's host it's `baxter-*`.)
- **Offline execution:** the sandbox has **no network**. Enforced resource maxima (run timeout, memory) live in **Piston's own config** (env vars on the Piston container), NOT only in `code-cli`'s request — because the Piston API is reachable without going through `code-cli` (see spec Security posture).
- **Languages:** Python and Node only. Piston language ids are confirmed in Task 2 (expected: `python`, and `javascript` for node — verify against `/api/v2/runtimes`).
- **Curated libs (offline-usable only — no HTTP clients):** Python `numpy`, `pandas`, `python-dateutil`, `beautifulsoup4`; Node `lodash`, `dayjs`.
- **Boundary:** the run's `--allowedTools` gains `Bash(code-cli *)` (both daemons). `code-cli` holds no secret. `"code"` must be added to `BAKED_SKILL_NAMES` in `runtime.mjs` so a learned skill can't shadow the `code` skill.
- **Entry-point guard:** `code-cli.mjs` guards its dispatch with `if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)` so tests can import its pure helpers without running the CLI (as `gmail.mjs`/`discord-cli.mjs` do).
- **Running unit tests:** the dev container lacks nothing for `code-cli.test.mjs` (it imports only `node:url`/`node:fs`), but the repo convention is to run `node --test` **inside the built `app-app:latest` image** via the throwaway-container `docker cp` pattern (see Task 5 for the exact incantation).
- **Commit trailers:** end each commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_013R7GwxgVf6Rg1T1Yvr7rZg`.
- **Fallback:** if Task 2 (the spike) shows libs can't be provisioned into Piston's runtimes cleanly, STOP and escalate — the spec's custom-broker fallback replaces Tasks 1–3 but keeps `code-cli`'s external interface (Tasks 4–8) unchanged.

---

## File Structure

**Created:**
- `app/scripts/code-cli.mjs` — token-less boundary CLI: pure helpers (`parseArgs`, `buildExecuteBody`, `formatResult`) + REST call + dispatch.
- `app/scripts/code-cli.test.mjs` — unit tests for the pure helpers.
- `app/skills/code/SKILL.md` — the `code` skill.
- `scripts/piston-provision.sh` — idempotent runtime + lib provisioning (repo-root scripts, alongside `claude-review/`).

**Modified:**
- `Makefile` — `piston`, `piston-provision` targets; `<project>-net` network; `--network` on `run`/`discord`.
- `app/Dockerfile` — `code-cli` shim on PATH.
- `app/scripts/poll.mjs`, `app/scripts/discord-bot.mjs` — `Bash(code-cli *)` in `allowedTools`; `code` skill in `SKILL_SRCS`.
- `app/scripts/runtime.mjs` — `"code"` in `BAKED_SKILL_NAMES`.
- `app/prompt.md`, `app/discord-prompt.md` — the `code-cli` line.
- `app/.env.example` — Piston knobs (`PISTON_RUN_TIMEOUT_MS`, `PISTON_RUN_MEMORY_LIMIT`, runtime versions).
- `app/CLAUDE.md` — a "Code execution (Piston)" section.

---

## Task 1: Stand up Piston as a standing service

**Files:**
- Modify: `Makefile`

**Interfaces:**
- Produces: a running `piston` container on network `<project>-net`, reachable at `http://piston:2000`; `make run`/`make discord` join the network.

- [ ] **Step 1: Add the network var and Piston config knobs to the Makefile**

After the `APP_CONFIG_VOLUME` line (Makefile ~line 36), add:

```makefile
APP_NET := $(PROJECT)-net
PISTON_VOLUME := $(PROJECT)-piston
# Enforced per-execution ceilings, pinned on the Piston container itself (not
# just code-cli's request) so a direct API caller can't exceed them.
PISTON_RUN_TIMEOUT ?= 15000
PISTON_RUN_MEMORY ?= 268435456
```

- [ ] **Step 2: Add `piston` and `piston-provision` to `.PHONY`**

Change the `.PHONY` line to include them:

```makefile
.PHONY: build-dev dev build-app run discord auth app-shell backup restore piston piston-provision
```

- [ ] **Step 3: Add the `piston` target**

Add after the `discord` target:

```makefile
# The offline code-execution sandbox. Standing service, privileged (its isolate
# sandbox needs it), on a user-defined network so run/discord can resolve it by
# name. Resource maxima are pinned here (PISTON_*), the enforced ceiling. After
# `make piston`, run `make piston-provision` once to install runtimes + libs.
piston:
	docker network inspect $(APP_NET) >/dev/null 2>&1 || docker network create $(APP_NET)
	docker rm -f piston >/dev/null 2>&1 || true
	docker run -d --name piston --restart unless-stopped \
		--privileged \
		--network $(APP_NET) \
		-v "$(PISTON_VOLUME):/piston/packages" \
		-e PISTON_RUN_TIMEOUT=$(PISTON_RUN_TIMEOUT) \
		-e PISTON_COMPILE_TIMEOUT=$(PISTON_RUN_TIMEOUT) \
		-e PISTON_RUN_MEMORY_LIMIT=$(PISTON_RUN_MEMORY) \
		ghcr.io/engineer-man/piston:latest
	@echo "piston starting on network $(APP_NET); run 'make piston-provision' once it's up."
```

- [ ] **Step 4: Join `run` and `discord` to the network**

In the `run` and `discord` targets, add `--network $(APP_NET)` to each `docker run` (after the `--memory`/`--shm-size` line):

```makefile
run: build-app
	docker run -it --rm \
		--memory=8g --shm-size=2g \
		--network $(APP_NET) \
		$(APP_ENV_FILE) \
		-v "$(APP_CONFIG_VOLUME):/home/node" \
		$(APP_IMAGE)
```

Do the same for `discord` (add the same `--network $(APP_NET)` line to its `docker run`).

- [ ] **Step 5: Bring it up and verify**

Run: `make piston`, then wait ~10s and check the API responds:
```bash
docker run --rm --network app-net curlimages/curl -s http://piston:2000/api/v2/runtimes | head -c 200
```
Expected: a JSON array (likely `[]` before provisioning, or existing runtimes). The point is the API answers over the network by name.

- [ ] **Step 6: Confirm run/discord still start on the network**

Run: `docker run --rm --network app-net --entrypoint node app-app:latest -e "console.log('net ok')"` (any image on the net) — or simply confirm `make -n run` shows `--network app-net`. Expected: the flag is present.

- [ ] **Step 7: Commit**

```bash
git add Makefile
git commit -m "Add Piston sandbox service: make piston + shared network"
```

---

## Task 2: SPIKE — verify runtime + library provisioning works (GATE)

This is a **verification spike**, not TDD. It proves the spec's one risk — that libraries installed into a Piston runtime are picked up at execution time — and produces the exact commands Task 3 codifies. **If it fails, STOP and escalate for the custom-broker fallback.**

**Files:** none (produces knowledge + notes for Task 3).

- [ ] **Step 1: Discover the available Python/Node runtime versions**

With `make piston` up:
```bash
docker exec piston sh -c 'cli/index.js ppman list' 2>/dev/null || \
  docker run --rm --network app-net curlimages/curl -s http://piston:2000/api/v2/packages | python3 -m json.tool | head -60
```
Record the exact `language`/`version` for Python and Node (e.g. `python 3.12.0`, `node 20.11.1`). Note the language id node uses (`node` vs `javascript`).

- [ ] **Step 2: Install the Python and Node runtimes**

```bash
docker exec piston sh -c 'cli/index.js ppman install python=3.12.0' || \
  docker run --rm --network app-net curlimages/curl -s -X POST http://piston:2000/api/v2/packages \
    -H 'Content-Type: application/json' -d '{"language":"python","version":"3.12.0"}'
docker exec piston sh -c 'cli/index.js ppman install node=20.11.1'   # adjust versions to Step 1
```
Expected: install success. Verify: `curl .../api/v2/runtimes` now lists python and node.

- [ ] **Step 3: Prove baseline execution works**

```bash
docker run --rm --network app-net curlimages/curl -s -X POST http://piston:2000/api/v2/execute \
  -H 'Content-Type: application/json' \
  -d '{"language":"python","version":"3.12.0","files":[{"content":"print(2+2)"}]}'
```
Expected: JSON with `run.stdout` == `"4\n"` and `run.code` == 0.

- [ ] **Step 4: Install a library into the runtime and prove it's picked up (THE RISK)**

Locate the installed runtime's python and its site-packages inside the container, then install numpy into it:
```bash
docker exec piston sh -c 'ls /piston/packages/python/*/'          # find the version dir
# The runtime's python is typically at /piston/packages/python/<ver>/bin/python3
docker exec piston sh -c '/piston/packages/python/3.12.0/bin/python3 -m pip install numpy 2>&1 | tail -3'
```
Then run code that imports it:
```bash
docker run --rm --network app-net curlimages/curl -s -X POST http://piston:2000/api/v2/execute \
  -H 'Content-Type: application/json' \
  -d '{"language":"python","version":"3.12.0","files":[{"content":"import numpy; print(numpy.__version__)"}]}'
```
- **PASS:** `run.stdout` shows a numpy version and `run.code` == 0. Record the exact `pip install` path/mechanism that worked — Task 3 uses it. Do the same check for node (`docker exec piston sh -c '<node-dir>/bin/npm install -g lodash'` or into the runtime's module path, then execute `require('lodash')`).
- **FAIL** (numpy not found at exec, or the runtime uses an isolated env that ignores the install): **STOP.** The lib-into-runtime approach doesn't hold on this Piston version. Escalate: switch to the spec's custom-broker fallback (own python/node images with libs baked in + a small HTTP runner) for Tasks 1–3; Tasks 4–8 are unchanged.

- [ ] **Step 5: Prove execution is offline**

```bash
docker run --rm --network app-net curlimages/curl -s -X POST http://piston:2000/api/v2/execute \
  -H 'Content-Type: application/json' \
  -d '{"language":"python","version":"3.12.0","files":[{"content":"import socket; socket.create_connection((\"1.1.1.1\",80),2)"}]}'
```
Expected: `run.stderr` shows a network error / timeout and `run.code` != 0 — i.e. no network. Record the observed behavior.

- [ ] **Step 6: Record findings**

Write the working versions, the exact per-runtime install commands (python + node), and the offline-confirmation in the task's report/notes. No commit (nothing changed in the repo). Task 3 codifies these commands.

---

## Task 3: `make piston-provision` — codify the provisioning

**Files:**
- Create: `scripts/piston-provision.sh`
- Modify: `Makefile`

**Interfaces:**
- Consumes: the exact runtime versions + install commands from Task 2.
- Produces: `make piston-provision`, idempotent — after it, `import numpy` / `require('lodash')` work in the sandbox.

- [ ] **Step 1: Write the provisioning script**

Create `scripts/piston-provision.sh` using the **exact commands Task 2 proved** (versions and install paths below are placeholders — substitute the real ones from Task 2):

```bash
#!/usr/bin/env bash
# Idempotent: installs the Python/Node runtimes into the running Piston service
# and the curated libraries into those runtimes (offline-usable only -- no HTTP
# clients, since sandbox execution has no network). Re-runnable; safe to repeat.
set -euo pipefail

PY_VER="${PISTON_PYTHON_VERSION:-3.12.0}"     # match Task 2
NODE_VER="${PISTON_NODE_VERSION:-20.11.1}"    # match Task 2
PY_LIBS="numpy pandas python-dateutil beautifulsoup4"
NODE_LIBS="lodash dayjs"

echo "== waiting for piston API =="
for i in $(seq 1 30); do
  if docker exec piston sh -c 'cli/index.js ppman list >/dev/null 2>&1'; then break; fi
  sleep 2
done

echo "== installing runtimes =="
docker exec piston sh -c "cli/index.js ppman install python=$PY_VER" || true
docker exec piston sh -c "cli/index.js ppman install node=$NODE_VER" || true

echo "== installing python libs into the runtime =="
docker exec piston sh -c "/piston/packages/python/$PY_VER/bin/python3 -m pip install --upgrade $PY_LIBS"

echo "== installing node libs into the runtime =="
docker exec piston sh -c "cd /piston/packages/node/$NODE_VER && bin/npm install -g $NODE_LIBS"   # adjust to Task 2's proven path

echo "== provisioning done =="
```

Make it executable: `chmod +x scripts/piston-provision.sh`.

- [ ] **Step 2: Add the `make piston-provision` target**

Add to the Makefile after `piston`:

```makefile
piston-provision:
	./scripts/piston-provision.sh
```

- [ ] **Step 3: Run it and verify libs work**

Run: `make piston-provision`, then:
```bash
docker run --rm --network app-net curlimages/curl -s -X POST http://piston:2000/api/v2/execute \
  -H 'Content-Type: application/json' \
  -d '{"language":"python","version":"3.12.0","files":[{"content":"import pandas,numpy,bs4,dateutil;print(\"ok\")"}]}'
```
Expected: `run.stdout` == `"ok\n"`, `run.code` 0. Same for node (`require('lodash');require('dayjs')`).

- [ ] **Step 4: Verify idempotency**

Run `make piston-provision` a second time. Expected: succeeds without error (installs are upgrade/no-op).

- [ ] **Step 5: Commit**

```bash
git add scripts/piston-provision.sh Makefile
git commit -m "Add make piston-provision: install runtimes + curated libs"
```

---

## Task 4: `code-cli` pure helpers (TDD)

**Files:**
- Create: `app/scripts/code-cli.mjs`
- Create: `app/scripts/code-cli.test.mjs`

**Interfaces:**
- Produces: `parseArgs(argv)` → `{ lang, file, timeoutMs }`; `buildExecuteBody({language, version, content, stdin, timeoutMs})` → Piston request object; `formatResult(res)` → string.

- [ ] **Step 1: Write the failing tests**

Create `app/scripts/code-cli.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, buildExecuteBody, formatResult } from "./code-cli.mjs";

test("parseArgs reads lang, --file, --timeout-ms with defaults", () => {
  assert.deepEqual(parseArgs(["python"]), { lang: "python", file: null, timeoutMs: 10000 });
  assert.deepEqual(parseArgs(["node", "--file", "s.js"]), { lang: "node", file: "s.js", timeoutMs: 10000 });
  assert.deepEqual(parseArgs(["python", "--timeout-ms", "5000"]), { lang: "python", file: null, timeoutMs: 5000 });
});

test("buildExecuteBody assembles a Piston execute request", () => {
  const body = buildExecuteBody({ language: "python", version: "3.12.0", content: "print(1)", stdin: "hi", timeoutMs: 5000 });
  assert.deepEqual(body, {
    language: "python",
    version: "3.12.0",
    files: [{ content: "print(1)" }],
    stdin: "hi",
    run_timeout: 5000,
  });
});

test("formatResult surfaces stdout, stderr, and exit code", () => {
  const out = formatResult({ run: { stdout: "4\n", stderr: "", code: 0 } });
  assert.match(out, /^4/);
  assert.match(out, /\[exit 0\]/);
  const err = formatResult({ run: { stdout: "", stderr: "boom\n", code: 1 } });
  assert.match(err, /\[stderr\]\nboom/);
  assert.match(err, /\[exit 1\]/);
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
docker run --rm app-app:latest node --test scripts/code-cli.test.mjs
```
Expected: FAIL — module not found / exports missing. (The image predates this file; that's fine, the next step's docker-cp verification is how tests actually run — see Task 5 Step 3. For now, just confirm it errors.)

- [ ] **Step 3: Implement the pure helpers**

Create `app/scripts/code-cli.mjs` (REST + dispatch added in Task 5):

```js
#!/usr/bin/env node
// Token-less boundary CLI for the offline Piston sandbox. The spawned claude
// run reaches code execution only through this (Bash(code-cli *)); no secret
// lives here -- it's a scoping/convenience layer over Piston's HTTP API. Raw
// fetch, no deps.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PISTON_URL = process.env.PISTON_URL || "http://piston:2000";
// Our lang name -> Piston language id (confirmed in Task 2's /runtimes check).
const PISTON_LANG = { python: "python", node: "javascript" };

export function parseArgs(argv) {
  const [lang, ...rest] = argv;
  const opts = { lang, file: null, timeoutMs: 10000 };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--file") opts.file = rest[++i];
    else if (rest[i] === "--timeout-ms") opts.timeoutMs = Number(rest[++i]);
  }
  return opts;
}

export function buildExecuteBody({ language, version, content, stdin, timeoutMs }) {
  return {
    language,
    version,
    files: [{ content }],
    stdin: stdin ?? "",
    run_timeout: timeoutMs,
  };
}

// Piston's /execute response: { run: {stdout, stderr, code, signal}, compile? }.
export function formatResult(res) {
  const run = res.run ?? {};
  const parts = [];
  if (res.compile && (res.compile.stdout || res.compile.stderr)) {
    parts.push(`[compile]\n${(res.compile.stdout || "") + (res.compile.stderr || "")}`.trimEnd());
  }
  if (run.stdout) parts.push(run.stdout.replace(/\n$/, ""));
  if (run.stderr) parts.push(`[stderr]\n${run.stderr.replace(/\n$/, "")}`);
  parts.push(`[exit ${run.code ?? "?"}${run.signal ? ` signal ${run.signal}` : ""}]`);
  return parts.join("\n");
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
make build-app
cid=$(docker create app-app:latest node --test /app/scripts/code-cli.test.mjs)
docker cp app/scripts/code-cli.mjs      "$cid:/app/scripts/code-cli.mjs"
docker cp app/scripts/code-cli.test.mjs "$cid:/app/scripts/code-cli.test.mjs"
docker start -a "$cid"; docker rm "$cid"
```
Expected: `# pass 3  # fail 0`.

- [ ] **Step 5: Commit**

```bash
git add app/scripts/code-cli.mjs app/scripts/code-cli.test.mjs
git commit -m "Add code-cli pure helpers (parse/build/format) with tests"
```

---

## Task 5: `code-cli` REST call + version resolution + dispatch

**Files:**
- Modify: `app/scripts/code-cli.mjs`

**Interfaces:**
- Consumes: `parseArgs`, `buildExecuteBody`, `formatResult` (Task 4); a running provisioned Piston (Tasks 1–3).
- Produces: CLI `code-cli python|node [--file <path>] [--timeout-ms <n>]` — code on stdin or `--file`; prints formatted result; exits 0 on a completed run (even if the code errored — the error is in the output), non-zero only on infrastructure failure (Piston unreachable, unknown language).

- [ ] **Step 1: Append the REST helpers and dispatch**

Append to `app/scripts/code-cli.mjs`:

```js
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// Resolve the installed version for a Piston language from /runtimes so we don't
// hard-code a version that drifts from what make piston-provision installed.
async function resolveVersion(pistonLang) {
  const res = await fetch(`${PISTON_URL}/api/v2/runtimes`);
  if (!res.ok) throw new Error(`piston /runtimes -> ${res.status}`);
  const runtimes = await res.json();
  const match = runtimes.find((r) => r.language === pistonLang || (r.aliases || []).includes(pistonLang));
  if (!match) throw new Error(`no ${pistonLang} runtime installed in the sandbox (run 'make piston-provision')`);
  return match.version;
}

async function execute({ pistonLang, content, timeoutMs }) {
  const version = await resolveVersion(pistonLang);
  const res = await fetch(`${PISTON_URL}/api/v2/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildExecuteBody({ language: pistonLang, version, content, stdin: "", timeoutMs })),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`piston /execute -> ${res.status}: ${text}`);
  return JSON.parse(text);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const opts = parseArgs(process.argv.slice(2));
  const pistonLang = PISTON_LANG[opts.lang];
  (async () => {
    try {
      if (!pistonLang) throw new Error(`usage: code-cli <python|node> [--file <path>] [--timeout-ms <n>]`);
      const content = opts.file ? readFileSync(opts.file, "utf8") : await readStdin();
      const result = await execute({ pistonLang, content, timeoutMs: opts.timeoutMs });
      console.log(formatResult(result));
    } catch (err) {
      // Infrastructure failure (unreachable/unknown lang) -- distinct from code
      // that ran and errored (that comes back in formatResult with a nonzero
      // [exit N]). A clear one-line message for the run to read.
      console.error(`code-cli: ${err.message}${/fetch|ECONNREFUSED|/.test(String(err)) ? " (is the sandbox up? 'make piston')" : ""}`);
      process.exit(1);
    }
  })();
}
```

- [ ] **Step 2: Regression — pure-helper tests still pass**

```bash
make build-app
cid=$(docker create app-app:latest node --test /app/scripts/code-cli.test.mjs)
docker cp app/scripts/code-cli.mjs "$cid:/app/scripts/code-cli.mjs"
docker cp app/scripts/code-cli.test.mjs "$cid:/app/scripts/code-cli.test.mjs"
docker start -a "$cid"; docker rm "$cid"
```
Expected: `# pass 3  # fail 0` (dispatch is entry-guarded, so importing for tests doesn't run it).

- [ ] **Step 3: Integration — run real code (Piston up + provisioned)**

```bash
echo 'import numpy; print(numpy.arange(3).sum())' | \
  docker run --rm -i --network app-net -e PISTON_URL=http://piston:2000 \
  -v "$(pwd)/app/scripts/code-cli.mjs:/app/scripts/code-cli.mjs" app-app:latest \
  node /app/scripts/code-cli.mjs python
```
Expected: output containing `3` and `[exit 0]`. Try `node`: `echo 'console.log(require("lodash").sum([1,2,3]))' | ... code-cli node` → `6` and `[exit 0]`.

- [ ] **Step 4: Integration — errors and sandbox-down**

- Code that throws: `echo 'raise SystemExit(2)' | ... code-cli python` → output shows `[exit 2]` (a *completed* run; code-cli exits 0).
- Sandbox unreachable: run the same with `-e PISTON_URL=http://piston:9999` (no listener) → stderr `code-cli: ... (is the sandbox up? ...)`, exit 1.

- [ ] **Step 5: Commit**

```bash
git add app/scripts/code-cli.mjs
git commit -m "Add code-cli REST execution, version resolution, and dispatch"
```

---

## Task 6: Wire `code-cli` into the daemons and image

**Files:**
- Modify: `app/Dockerfile`, `app/scripts/poll.mjs`, `app/scripts/discord-bot.mjs`, `app/scripts/runtime.mjs`, `app/prompt.md`, `app/discord-prompt.md`

**Interfaces:**
- Consumes: `code-cli.mjs` (Tasks 4–5), the `code` skill (Task 7 — `SKILL_SRCS` entry is added here but the dir is created in Task 7; order the commits so the dir exists before a run, or land Task 7 first).

- [ ] **Step 1: Install the `code-cli` shim on PATH**

In `app/Dockerfile`, next to the `discord-cli` shim, add:

```dockerfile
RUN printf '#!/bin/sh\nexec node /app/scripts/code-cli.mjs "$@"\n' \
      > /usr/local/bin/code-cli \
    && chmod +x /usr/local/bin/code-cli
```

- [ ] **Step 2: Grant `Bash(code-cli *)` in both daemons**

In `app/scripts/poll.mjs` (the `allowedTools:` string) and `app/scripts/discord-bot.mjs` (the `const allowedTools =` string), add `Bash(code-cli *)` to the list, e.g. discord-bot:

```js
const allowedTools = `Bash(node ${DISCORD_CLI_PATH} *) Bash(discord-cli *) Bash(code-cli *) Bash(playwright-cli *) Bash(invisible-cli *) WebSearch WebFetch Skill Read Write Edit`;
```
(and the equivalent one-line edit in `poll.mjs`).

- [ ] **Step 3: Add the `code` skill to `SKILL_SRCS` in both daemons**

In both files' `SKILL_SRCS` array, add `join(APP_DIR, "skills", "code")`.

- [ ] **Step 4: Reserve the `code` skill name**

In `app/scripts/runtime.mjs`, change `BAKED_SKILL_NAMES`:

```js
const BAKED_SKILL_NAMES = new Set(["playwright-cli", "invisible-playwright", "discord", "code"]);
```

- [ ] **Step 5: Add the prompt line (both prompts)**

In `app/discord-prompt.md` and `app/prompt.md`, add under "What you can do":

```markdown
- Run Python or Node code in an offline sandbox with `code-cli` (see the code skill): `code-cli python` / `code-cli node` with the program on stdin, or `--file <path>`. Available libs -- Python: numpy, pandas, python-dateutil, beautifulsoup4; Node: lodash, dayjs. There's NO network in the sandbox (fetch pages with WebFetch / the browser, then pipe the content in to parse). Use it for computation, parsing, and data work; save reusable scripts to your working directory and re-run with `--file`.
```

- [ ] **Step 6: Build, verify wiring, confirm daemons start**

```bash
make build-app
docker run --rm app-app:latest sh -c 'command -v code-cli && echo shim-ok'
grep -q "Bash(code-cli \*)" app/scripts/poll.mjs app/scripts/discord-bot.mjs && echo grants-ok
docker run --rm app-app:latest node --test scripts/runtime.test.mjs 2>&1 | grep -E "# (pass|fail)"
```
Expected: shim path printed + `shim-ok`; `grants-ok`; runtime tests still pass (BAKED_SKILL_NAMES change doesn't break the existing shadow/prune tests — `code` just joins the reserved set).

- [ ] **Step 7: Commit**

```bash
git add app/Dockerfile app/scripts/poll.mjs app/scripts/discord-bot.mjs app/scripts/runtime.mjs app/prompt.md app/discord-prompt.md
git commit -m "Wire code-cli into daemons: shim, allowedTools, SKILL_SRCS, prompts"
```

---

## Task 7: The `code` skill

**Files:**
- Create: `app/skills/code/SKILL.md`

**Interfaces:**
- Consumes: the `code-cli` command surface (Tasks 4–5). Copied into the run's cwd by `ensureSkills` via `SKILL_SRCS` (Task 6). **Land this before or with Task 6** so the `SKILL_SRCS` entry points at an existing dir.

- [ ] **Step 1: Write the skill**

Create `app/skills/code/SKILL.md`, following the frontmatter shape of `app/skills/discord/SKILL.md` (read it first). Frontmatter: `name: code`, a one-line `description`, `allowed-tools: Bash(code-cli:*)`. Body documents: the two commands (`code-cli python` / `code-cli node`, program on **stdin** or `--file <path>`); the available libraries (Python numpy/pandas/python-dateutil/beautifulsoup4; Node lodash/dayjs); that execution is **offline** (no network — fetch with WebFetch/browser, pipe content in to parse/compute), **ephemeral**, and **time/memory-capped**; the output format (stdout, `[stderr]`, `[exit N]`); and the write→save→reuse loop (save a `.py`/`.js` to the working dir, re-run with `--file`).

- [ ] **Step 2: Verify frontmatter parses**

Read it back; confirm the frontmatter keys match `app/skills/discord/SKILL.md`'s structure (valid YAML, `allowed-tools: Bash(code-cli:*)`).

- [ ] **Step 3: Commit**

```bash
git add app/skills/code/SKILL.md
git commit -m "Add the code skill documenting code-cli"
```

---

## Task 8: Docs and end-to-end verification

**Files:**
- Modify: `app/.env.example`, `app/CLAUDE.md`

- [ ] **Step 1: Add Piston knobs to `.env.example`**

Append to `app/.env.example`:

```bash
# --- Code execution sandbox (Piston) ---
# Enforced per-execution ceilings, pinned on the Piston container (make piston),
# NOT just code-cli's request -- the API is reachable without code-cli, so these
# are the real limit. run_timeout is ms; memory is bytes.
PISTON_RUN_TIMEOUT=15000
PISTON_RUN_MEMORY=268435456
# Runtime versions provisioned into the sandbox (match make piston-provision).
PISTON_PYTHON_VERSION=3.12.0
PISTON_NODE_VERSION=20.11.1
```
(Use the versions Task 2 confirmed.)

- [ ] **Step 2: Document in `app/CLAUDE.md`**

Add a "Code execution (Piston)" section: the standing service + shared network + named volume; `make piston` then `make piston-provision`; `code-cli` as the credential-less scoped boundary (raw fetch, `Bash(code-cli *)`, `code` in `SKILL_SRCS`/`BAKED_SKILL_NAMES`); the **offline** property and that per-exec maxima are enforced in Piston's config; the **honest boundary** note (the Piston API is unauthenticated and reachable other ways — browser `eval` — so worst case is offline capped execution + package install/uninstall, never host; privileged-Piston residual risk). Mirror the spec's Security posture.

- [ ] **Step 3: End-to-end**

With `make piston` + `make piston-provision` up and the app on the network:
1. `make discord` (or `make run`); send a message asking Baxter to "compute the mean of [2,4,6] with numpy and tell me". Confirm the log shows a `code-cli python` call and he reports `4`.
2. Ask him to save that as a script and re-run it — confirm a `.py` appears in `memory-workspace` and re-runs via `--file`.
3. Confirm an offline attempt (ask him to fetch a URL *inside* code) fails and he falls back to WebFetch/browser for fetching.

- [ ] **Step 4: Commit**

```bash
git add app/.env.example app/CLAUDE.md
git commit -m "Document the Piston code sandbox (.env.example, CLAUDE.md)"
```

---

## Self-Review

**Spec coverage:**
- Piston standing service + shared network + named volume → Task 1. ✓
- The lib-provisioning risk as a verify-first gate + custom-broker fallback → Task 2. ✓
- `make piston-provision` (runtimes + curated offline libs) → Task 3. ✓
- `code-cli` boundary (stdin/`--file`, REST, version resolution, error handling) → Tasks 4–5. ✓
- Offline execution + enforced maxima in Piston's config → Task 1 (config) + Task 2 Step 5 (offline check) + Task 8. ✓
- `Bash(code-cli *)`, `SKILL_SRCS`, `"code"` in `BAKED_SKILL_NAMES`, shim → Task 6. ✓
- `code` skill + prompt lines → Tasks 6–7. ✓
- Save/reuse loop → Task 6 prompt line + Task 8 e2e. ✓
- Honest-boundary + residual-risk docs → Task 8. ✓
- Curated libs (no HTTP clients) → Tasks 3, 6, 7. ✓

**Placeholder scan:** The provisioning versions/paths in Tasks 2–3 are explicitly "substitute the real ones Task 2 proved" — that's the spike's deliverable feeding Task 3, not an unfilled placeholder. No "TODO"/"handle errors"/vague steps remain; every code step shows code.

**Type consistency:** `parseArgs`→`{lang,file,timeoutMs}`, `buildExecuteBody({language,version,content,stdin,timeoutMs})`, `formatResult(res.run.{stdout,stderr,code,signal})`, `PISTON_LANG` map, `resolveVersion(pistonLang)`, `execute({pistonLang,content,timeoutMs})` — names/shapes match across Tasks 4 and 5. `BAKED_SKILL_NAMES` add is consistent with `SKILL_SRCS`/skill dir name `code`.
