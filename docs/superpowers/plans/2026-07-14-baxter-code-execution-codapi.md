# Baxter Code Execution via codapi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Baxter offline Python/Node code execution in an isolated codapi sandbox, reached only through a scoped `code-cli`, with a curated set of pre-installed libraries — arm64-native (Piston/Judge0 can't run here; see the design spec).

**Architecture:** A small `baxter-codapi` service (codapi Go binary in a `docker:cli` image, config baked in) runs as a standing service on a shared docker network (`<project>-net`). codapi shells out to the host docker daemon (via the mounted socket) to run each request in a fresh, hardened, **offline** sandbox container built from our own arm64 images (`codapi/python`, `codapi/node`) with libs baked in. The spawned `claude -p` run reaches it via `code-cli` (a token-less boundary CLI, raw `fetch` → codapi's `/v1/exec`), mirroring the `gmail.mjs`/`discord-cli` pattern. Enforced resource maxima live in codapi's own config (`codapi.json`).

**Tech Stack:** Node 22 (ESM), codapi v0.14.0 (`linux_arm64`), `docker:cli` base image, official `python:3.12-slim` / `node:20-slim` sandbox bases, codapi HTTP API `/v1/exec`, Docker (network + socket), `node:test`.

## Global Constraints

- **Host is native `aarch64`.** Sandboxes are Docker images we build from official multi-arch bases — no emulation, no runtime-package building. (This is why codapi, not Piston; the spike proved Piston's isolate/amd64-packages fail here.)
- **codapi is NOT privileged.** It gets the **docker socket** (`-v /var/run/docker.sock:/var/run/docker.sock`) to launch sandbox siblings on the host daemon. The socket is the elevated grant (host-root-equivalent) and the residual trust boundary — Baxter never touches it; he reaches codapi only via `code-cli` → HTTP.
- **docker-outside-of-docker `TMPDIR` rule (load-bearing, proven in spike):** codapi writes each request's code to `os.MkdirTemp` (honors `TMPDIR`) and bind-mounts `<dir>:/sandbox:ro` into the sandbox. That source path must resolve on the **host** daemon. So run codapi with `-e TMPDIR=<host-path>` **and** `-v <host-path>:<host-path>` at an identical path. Config is **baked into the server image** (not bind-mounted) for the same reason — a bind-mount source must be a host path, and the config lives in the build context.
- **`PROJECT := $(notdir $(CURDIR))`** (existing Makefile line 1) — all names are `<project>-*`. Every `make` target for this feature runs from the same directory as `run`/`discord` so they share the network. (Dev container: `app-*`; operator host: `baxter-*`.)
- **Offline execution:** the sandbox has **no network** (`network:"none"` in `codapi.json`). Enforced maxima (memory, pids, timeout) live in `codapi.json` (baked into the server image), NOT only in `code-cli`'s request — codapi applies the box config server-side regardless of caller, and the API is reachable without going through `code-cli` (see spec Security posture).
- **Sandbox names = languages:** `python` and `node`. A codapi sandbox name fully identifies the runtime — **no version resolution** (unlike the Piston design).
- **Curated libs (offline-usable only — no HTTP clients):** Python `numpy`, `pandas`, `python-dateutil`, `beautifulsoup4`; Node `lodash`, `dayjs`. Listed once, in the two sandbox Dockerfiles.
- **codapi binary pin:** `codapi_0.14.0_linux_arm64.tar.gz` from `github.com/nalgeon/codapi/releases`, verified by SHA-256 at build (the Dockerfile downloads + checks). Pin the version in a Makefile var.
- **Boundary:** the run's `--allowedTools` gains `Bash(code-cli *)` (both daemons). `code-cli` holds no secret. `"code"` must be added to `BAKED_SKILL_NAMES` in `runtime.mjs` so a learned skill can't shadow the `code` skill.
- **Entry-point guard:** `code-cli.mjs` guards its dispatch with `if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)` so tests can import its pure helpers without running the CLI (as `gmail.mjs`/`discord-cli.mjs` do).
- **Running unit tests:** run `node --test` **inside the built `app-app:latest` image** via the throwaway-container `docker cp` pattern (Task 2 Step 4 has the exact incantation).
- **Commit trailers:** end each commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_013R7GwxgVf6Rg1T1Yvr7rZg`.

---

## File Structure

**Created:**
- `app/scripts/code-cli.mjs` — token-less boundary CLI: pure helpers (`parseArgs`, `buildRequestBody`, `formatResult`) + REST call + dispatch.
- `app/scripts/code-cli.test.mjs` — unit tests for the pure helpers.
- `app/skills/code/SKILL.md` — the `code` skill.
- `app/sandboxes/python/Dockerfile`, `app/sandboxes/node/Dockerfile` — arm64 sandbox images (libs baked in).
- `app/codapi/codapi.json` — codapi box/step config (enforced limits).
- `app/codapi/sandboxes/python/{box.json,commands.json}`, `app/codapi/sandboxes/node/{box.json,commands.json}` — codapi sandbox definitions.
- `app/codapi/Dockerfile` — the `baxter-codapi` server image.

**Modified:**
- `Makefile` — `codapi` target; `<project>-net` network; `--network` + network-ensure on `run`/`discord`.
- `app/Dockerfile` — `code-cli` shim on PATH.
- `app/scripts/poll.mjs`, `app/scripts/discord-bot.mjs` — `Bash(code-cli *)` in `allowedTools`; `code` skill in `SKILL_SRCS`.
- `app/scripts/runtime.mjs` — `"code"` in `BAKED_SKILL_NAMES`.
- `app/prompt.md`, `app/discord-prompt.md` — the `code-cli` line.
- `app/CLAUDE.md` — a "Code execution (codapi)" section.
- `app/.env.example` — a single honest knob: `CODAPI_URL` (optional; default `http://codapi:1313`). Enforced limits live in `codapi.json`, tuned there + `make codapi` (documented in CLAUDE.md), NOT as dangling env vars.

---

## Task 1: Stand up codapi as a standing service (controller-run; Docker-heavy)

**Files:**
- Create: `app/sandboxes/python/Dockerfile`, `app/sandboxes/node/Dockerfile`, `app/codapi/codapi.json`, `app/codapi/sandboxes/python/{box.json,commands.json}`, `app/codapi/sandboxes/node/{box.json,commands.json}`, `app/codapi/Dockerfile`
- Modify: `Makefile`

**Interfaces:**
- Produces: `make codapi` → sandbox images `codapi/python` + `codapi/node` built, and a running `codapi` container on `<project>-net`, reachable at `http://codapi:1313`, answering `POST /v1/exec`; `make run`/`make discord` join the network (creating it if absent).

- [ ] **Step 1: Sandbox Dockerfiles** (proven in spike)

`app/sandboxes/python/Dockerfile`:
```dockerfile
FROM python:3.12-slim
RUN adduser --home /sandbox --disabled-password --gecos "" sandbox \
 && pip install --no-cache-dir numpy pandas python-dateutil beautifulsoup4
USER sandbox
WORKDIR /sandbox
```
`app/sandboxes/node/Dockerfile` — **libs must live OUTSIDE `/sandbox`**: codapi bind-mounts the per-run code dir over `/sandbox` (see `codapi.json` `volume`), which would shadow a `node_modules` baked there. Install to `/opt/nodelibs` and point `NODE_PATH` at it:
```dockerfile
FROM node:20-slim
RUN adduser --home /sandbox --disabled-password --gecos "" sandbox
RUN mkdir -p /opt/nodelibs \
 && cd /opt/nodelibs && npm install --no-fund --no-audit lodash dayjs
ENV NODE_PATH=/opt/nodelibs/node_modules
USER sandbox
WORKDIR /sandbox
```

- [ ] **Step 2: codapi config**

`app/codapi/codapi.json` (secure defaults + enforced ceilings):
```json
{
    "pool_size": 8,
    "verbose": true,
    "box": {
        "runtime": "runc",
        "cpu": 1,
        "memory": 256,
        "network": "none",
        "writable": false,
        "volume": "%s:/sandbox:ro",
        "cap_drop": ["all"],
        "ulimit": ["nofile=96"],
        "nproc": 64
    },
    "step": {
        "user": "sandbox",
        "action": "run",
        "timeout": 10,
        "noutput": 8192
    }
}
```
`app/codapi/sandboxes/python/box.json`: `{ "image": "codapi/python" }`
`app/codapi/sandboxes/python/commands.json`:
```json
{
    "run": {
        "engine": "docker",
        "entry": "main.py",
        "steps": [ { "box": "python", "command": ["python", "main.py"] } ]
    }
}
```
`app/codapi/sandboxes/node/box.json`: `{ "image": "codapi/node" }`
`app/codapi/sandboxes/node/commands.json`: same shape, `entry: "main.js"`, step `command: ["node", "main.js"]`, `box: "node"`.

- [ ] **Step 3: codapi server Dockerfile** (config baked in; pinned binary + checksum)

`app/codapi/Dockerfile`:
```dockerfile
FROM docker:cli
ARG CODAPI_VERSION=0.14.0
ARG CODAPI_SHA256=<fill: sha256 of codapi_0.14.0_linux_arm64.tar.gz>
WORKDIR /opt/codapi
ADD https://github.com/nalgeon/codapi/releases/download/v${CODAPI_VERSION}/codapi_${CODAPI_VERSION}_linux_arm64.tar.gz /tmp/codapi.tgz
RUN echo "${CODAPI_SHA256}  /tmp/codapi.tgz" | sha256sum -c - \
 && tar xzf /tmp/codapi.tgz -C /opt/codapi codapi \
 && rm /tmp/codapi.tgz && chmod +x /opt/codapi/codapi
COPY codapi.json /opt/codapi/codapi.json
COPY sandboxes /opt/codapi/sandboxes
CMD ["./codapi"]
```
(Get the real SHA-256: `curl -sL <url> | sha256sum`. Put it in the Dockerfile default AND the Makefile var below.)

- [ ] **Step 4: Makefile — vars, `.PHONY`, `codapi` target, network on run/discord**

After the `APP_CONFIG_VOLUME` line, add:
```makefile
APP_NET := $(PROJECT)-net
CODAPI_TMP := /var/tmp/$(PROJECT)-codapi
CODAPI_VERSION ?= 0.14.0
CODAPI_SHA256 ?= <fill: same sha as the Dockerfile>
```
Add `codapi` to `.PHONY`. Add the target (after `discord`):
```makefile
# The offline code-execution sandbox (codapi). Builds the arm64 python/node
# sandbox images + the codapi server image (config baked in), then runs codapi
# on the shared network. NOT privileged -- it gets the docker socket to launch
# hardened sandbox siblings. TMPDIR is bind-mounted at an identical host path so
# codapi's per-run code dir resolves on the host daemon (docker-outside-of-docker).
# Enforced limits live in app/codapi/codapi.json.
codapi:
	docker network inspect $(APP_NET) >/dev/null 2>&1 || docker network create $(APP_NET)
	docker build -t codapi/python app/sandboxes/python
	docker build -t codapi/node   app/sandboxes/node
	docker build -t $(PROJECT)-codapi \
		--build-arg CODAPI_VERSION=$(CODAPI_VERSION) \
		--build-arg CODAPI_SHA256=$(CODAPI_SHA256) app/codapi
	docker rm -f codapi >/dev/null 2>&1 || true
	docker run -d --name codapi --restart unless-stopped \
		--network $(APP_NET) \
		-v /var/run/docker.sock:/var/run/docker.sock \
		-v $(CODAPI_TMP):$(CODAPI_TMP) \
		-e TMPDIR=$(CODAPI_TMP) \
		$(PROJECT)-codapi
	@echo "codapi running on $(APP_NET) at http://codapi:1313"
```
In `run` and `discord`, before each `docker run`, add the network-ensure line, and add `--network $(APP_NET)` to the run args:
```makefile
run: build-app
	docker network inspect $(APP_NET) >/dev/null 2>&1 || docker network create $(APP_NET)
	docker run -it --rm \
		--memory=8g --shm-size=2g \
		--network $(APP_NET) \
		$(APP_ENV_FILE) \
		-v "$(APP_CONFIG_VOLUME):/home/node" \
		$(APP_IMAGE)
```
(Same two additions for `discord`.) — This closes the review finding that `--network` without a network-ensure hard-fails `run`/`discord`.

- [ ] **Step 5: Bring it up and verify end-to-end**

```bash
make codapi
sleep 3
docker run --rm --network app-net curlimages/curl -s -X POST http://codapi:1313/v1/exec \
  -H 'content-type: application/json' \
  -d '{"sandbox":"python","command":"run","files":{"":"import numpy;print(numpy.arange(10).sum())"}}'
```
Expected: `{"id":...,"ok":true,...,"stdout":"45\n","stderr":""}`. Repeat for node: `{"sandbox":"node",...,"files":{"":"console.log(require(\"lodash\").sum([1,2,3]))"}}` → `stdout":"6\n"`. Offline check: `files:{"":"import socket;socket.create_connection(('1.1.1.1',53),3)"}` → `ok:false`, stderr shows `Network is unreachable`.

- [ ] **Step 6: Confirm run/discord carry the network**

`make -n run` and `make -n discord` show both the network-ensure line and `--network app-net`.

- [ ] **Step 7: Commit**
```bash
git add Makefile app/sandboxes app/codapi
git commit -m "Add codapi code-execution sandbox: make codapi + shared network"
```

---

## Task 2: `code-cli` pure helpers (TDD)

**Files:**
- Create: `app/scripts/code-cli.mjs`, `app/scripts/code-cli.test.mjs`

**Interfaces:**
- Produces: `parseArgs(argv)` → `{ lang, file }`; `buildRequestBody({sandbox, content})` → codapi `/v1/exec` request object; `formatResult(res)` → string.

- [ ] **Step 1: Write the failing tests**

Create `app/scripts/code-cli.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, buildRequestBody, formatResult } from "./code-cli.mjs";

test("parseArgs reads lang and --file", () => {
  assert.deepEqual(parseArgs(["python"]), { lang: "python", file: null });
  assert.deepEqual(parseArgs(["node", "--file", "s.js"]), { lang: "node", file: "s.js" });
});

test("parseArgs rejects a value-less --file (dangling or empty)", () => {
  assert.throws(() => parseArgs(["python", "--file"]), /--file requires a path/);
  assert.throws(() => parseArgs(["python", "--file", ""]), /--file requires a path/);
});

test("buildRequestBody assembles a codapi /v1/exec request", () => {
  assert.deepEqual(buildRequestBody({ sandbox: "python", content: "print(1)" }), {
    sandbox: "python",
    command: "run",
    files: { "": "print(1)" },
  });
});

test("formatResult surfaces stdout, stderr, and ok", () => {
  const out = formatResult({ ok: true, stdout: "4\n", stderr: "" });
  assert.match(out, /^4/);
  assert.match(out, /\[ok\]/);
  const err = formatResult({ ok: false, stdout: "", stderr: "boom\n" });
  assert.match(err, /\[stderr\]\nboom/);
  assert.match(err, /\[error\]/);
});
```

- [ ] **Step 2: Run to confirm failure**
```bash
docker run --rm app-app:latest node --test scripts/code-cli.test.mjs
```
Expected: FAIL — module/exports missing (the image predates the file; the docker-cp pattern in Step 4 is how tests really run).

- [ ] **Step 3: Implement the pure helpers**

Create `app/scripts/code-cli.mjs` (REST + dispatch added in Task 3):
```js
#!/usr/bin/env node
// Token-less boundary CLI for the offline codapi sandbox. The spawned claude
// run reaches code execution only through this (Bash(code-cli *)); no secret
// lives here -- it's a scoping/convenience layer over codapi's HTTP API. Raw
// fetch, no deps.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CODAPI_URL = process.env.CODAPI_URL || "http://codapi:1313";
// Our lang name == codapi sandbox name (no version resolution needed).
const SANDBOXES = new Set(["python", "node"]);

export function parseArgs(argv) {
  const [lang, ...rest] = argv;
  const opts = { lang, file: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--file") {
      // Reject a value-less flag at the parse boundary (mirrors discord-cli's
      // parseFlags), so `file` is only ever null (stdin) or a real path -- no
      // tri-state for the dispatch to disambiguate. `!path` catches both a
      // dangling `--file` (undefined) and `--file ""` (unset shell var).
      const path = rest[++i];
      if (!path) throw new Error("--file requires a path");
      opts.file = path;
    }
  }
  return opts;
}

export function buildRequestBody({ sandbox, content }) {
  return { sandbox, command: "run", files: { "": content } };
}

// codapi /v1/exec response: { id, ok, duration, stdout, stderr }.
export function formatResult(res) {
  const parts = [];
  if (res.stdout) parts.push(res.stdout.replace(/\n$/, ""));
  if (res.stderr) parts.push(`[stderr]\n${res.stderr.replace(/\n$/, "")}`);
  parts.push(res.ok ? "[ok]" : "[error]");
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
Expected: `# pass 4  # fail 0`.

- [ ] **Step 5: Commit**
```bash
git add app/scripts/code-cli.mjs app/scripts/code-cli.test.mjs
git commit -m "Add code-cli pure helpers (parse/build/format) with tests"
```

---

## Task 3: `code-cli` REST call + dispatch

**Files:**
- Modify: `app/scripts/code-cli.mjs`

**Interfaces:**
- Consumes: `parseArgs`, `buildRequestBody`, `formatResult` (Task 2); a running codapi (Task 1).
- Produces: CLI `code-cli python|node [--file <path>]` — code on stdin or `--file`; prints formatted result; exits 0 on a completed run (even if the code errored — the error is in the output), non-zero only on infrastructure failure (codapi unreachable, unknown language).

- [ ] **Step 1: Append the REST helper and dispatch**
```js
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function execute({ sandbox, content }) {
  const res = await fetch(`${CODAPI_URL}/v1/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildRequestBody({ sandbox, content })),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`codapi /v1/exec -> ${res.status}: ${text}`);
  return JSON.parse(text);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  (async () => {
    try {
      // parseArgs is inside the try so a bad --file surfaces as the clean
      // one-line `code-cli: --file requires a path`, not an uncaught throw.
      const opts = parseArgs(process.argv.slice(2));
      if (!SANDBOXES.has(opts.lang)) throw new Error(`usage: code-cli <python|node> [--file <path>]`);
      // opts.file is null (stdin) or a real path -- parseArgs already rejected
      // a value-less --file, so no guard is needed here.
      const content = opts.file ? readFileSync(opts.file, "utf8") : await readStdin();
      const result = await execute({ sandbox: opts.lang, content });
      console.log(formatResult(result));
    } catch (err) {
      // Infrastructure failure (unreachable/unknown lang) -- distinct from code
      // that ran and errored (that comes back in formatResult with [error]). The
      // reachability hint fires ONLY on a connection error, not every error.
      const connFailed = /ECONNREFUSED|EAI_AGAIN|fetch failed/i.test(String(err));
      console.error(`code-cli: ${err.message}${connFailed ? " (is the sandbox up? 'make codapi')" : ""}`);
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
Expected: `# pass 4  # fail 0` (dispatch is entry-guarded).

- [ ] **Step 3: Integration — run real code (codapi up)**
```bash
echo 'import numpy; print(numpy.arange(3).sum())' | \
  docker run --rm -i --network app-net -e CODAPI_URL=http://codapi:1313 \
  -v "$(pwd)/app/scripts/code-cli.mjs:/app/scripts/code-cli.mjs" app-app:latest \
  node /app/scripts/code-cli.mjs python
```
Expected: `3` then `[ok]`. Node: `echo 'console.log(require("lodash").sum([1,2,3]))' | ... code-cli node` → `6` and `[ok]`.

- [ ] **Step 4: Integration — errors and sandbox-down**
- Code that throws: `echo 'raise SystemExit(2)' | ... code-cli python` → output ends `[error]` (a *completed* run; code-cli exits 0).
- Sandbox unreachable: same with `-e CODAPI_URL=http://codapi:9999` → stderr `code-cli: ... (is the sandbox up? 'make codapi')`, exit 1.

- [ ] **Step 5: Commit**
```bash
git add app/scripts/code-cli.mjs
git commit -m "Add code-cli REST execution and dispatch"
```

---

## Task 4: The `code` skill

**Files:**
- Create: `app/skills/code/SKILL.md`

**Interfaces:**
- Consumes: the `code-cli` command surface (Tasks 2–3). Copied into the run's cwd by `ensureSkills` via `SKILL_SRCS` (added in Task 5). **This task lands before Task 5** so the `SKILL_SRCS` entry points at an existing dir (fixes the Piston plan's ordering finding).

- [ ] **Step 1: Write the skill**

Create `app/skills/code/SKILL.md`, following the frontmatter shape of `app/skills/discord/SKILL.md` (read it first). Frontmatter: `name: code`, a one-line `description`, `allowed-tools: Bash(code-cli:*)`. Body documents: the two commands (`code-cli python` / `code-cli node`, program on **stdin** or `--file <path>`); the available libraries (Python numpy/pandas/python-dateutil/beautifulsoup4; Node lodash/dayjs); that execution is **offline** (no network — fetch with WebFetch/browser, pipe content in to parse/compute), **ephemeral**, non-root, and **time/memory-capped**; the output format (stdout, `[stderr]`, `[ok]`/`[error]`); and the write→save→reuse loop (save a `.py`/`.js` to the working dir, re-run with `--file`).

- [ ] **Step 2: Verify frontmatter parses**

Read it back; confirm the frontmatter keys match `app/skills/discord/SKILL.md`'s structure (valid YAML, `allowed-tools: Bash(code-cli:*)`).

- [ ] **Step 3: Commit**
```bash
git add app/skills/code/SKILL.md
git commit -m "Add the code skill documenting code-cli"
```

---

## Task 5: Wire `code-cli` into the daemons and image

**Files:**
- Modify: `app/Dockerfile`, `app/scripts/poll.mjs`, `app/scripts/discord-bot.mjs`, `app/scripts/runtime.mjs`, `app/prompt.md`, `app/discord-prompt.md`

**Interfaces:**
- Consumes: `code-cli.mjs` (Tasks 2–3) and the `code` skill dir (Task 4, already committed).

- [ ] **Step 1: Install the `code-cli` shim on PATH**

In `app/Dockerfile`, next to the `discord-cli` shim, add:
```dockerfile
RUN printf '#!/bin/sh\nexec node /app/scripts/code-cli.mjs "$@"\n' \
      > /usr/local/bin/code-cli \
    && chmod +x /usr/local/bin/code-cli
```

- [ ] **Step 2: Grant `Bash(code-cli *)` in both daemons**

In `app/scripts/poll.mjs` (the `allowedTools` string) and `app/scripts/discord-bot.mjs` (the `const allowedTools =` string), add `Bash(code-cli *)`, e.g. discord-bot:
```js
const allowedTools = `Bash(node ${DISCORD_CLI_PATH} *) Bash(discord-cli *) Bash(code-cli *) Bash(playwright-cli *) Bash(invisible-cli *) WebSearch WebFetch Skill Read Write Edit`;
```
(and the equivalent one-line edit in `poll.mjs`).

- [ ] **Step 3: Add the `code` skill to `SKILL_SRCS` in both daemons**

In both files' `SKILL_SRCS` array, add `join(APP_DIR, "skills", "code")`.

- [ ] **Step 4: Reserve the `code` skill name**

In `app/scripts/runtime.mjs`:
```js
const BAKED_SKILL_NAMES = new Set(["playwright-cli", "invisible-playwright", "discord", "code"]);
```

- [ ] **Step 5: Add the prompt line (both prompts)**

In `app/discord-prompt.md` and `app/prompt.md`, add under "What you can do":
```markdown
- Run Python or Node code in an offline sandbox with `code-cli` (see the code skill): `code-cli python` / `code-cli node` with the program on stdin, or `--file <path>`. Available libs -- Python: numpy, pandas, python-dateutil, beautifulsoup4; Node: lodash, dayjs. There's NO network in the sandbox (fetch pages with WebFetch / the browser, then pipe the content in to parse). Use it for computation, parsing, and data work; save reusable scripts to your working directory and re-run with `--file`.
```

- [ ] **Step 6: Build, verify wiring, confirm tests**
```bash
make build-app
docker run --rm app-app:latest sh -c 'command -v code-cli && echo shim-ok'
grep -q "Bash(code-cli \*)" app/scripts/poll.mjs app/scripts/discord-bot.mjs && echo grants-ok
docker run --rm app-app:latest node --test scripts/runtime.test.mjs 2>&1 | grep -E "# (pass|fail)"
```
Expected: shim path + `shim-ok`; `grants-ok`; runtime tests still pass (`code` just joins the reserved set).

- [ ] **Step 7: Commit**
```bash
git add app/Dockerfile app/scripts/poll.mjs app/scripts/discord-bot.mjs app/scripts/runtime.mjs app/prompt.md app/discord-prompt.md
git commit -m "Wire code-cli into daemons: shim, allowedTools, SKILL_SRCS, prompts"
```

---

## Task 6: Docs and end-to-end verification

**Files:**
- Modify: `app/.env.example`, `app/CLAUDE.md`

- [ ] **Step 1: `.env.example` — one honest knob**

Append to `app/.env.example`:
```bash
# --- Code execution sandbox (codapi) ---
# Where the app reaches the codapi service (see `make codapi`). Default works on
# the shared docker network; override only if you relocate the service.
# CODAPI_URL=http://codapi:1313
# Enforced per-run limits (memory, pids, timeout, offline) live in
# app/codapi/codapi.json -- edit there and re-run `make codapi` to change them.
```
(No dangling knobs: the enforced limits are in `codapi.json`, not fake env vars — fixes the Piston plan's `.env` finding.)

- [ ] **Step 2: Document in `app/CLAUDE.md`**

Add a "Code execution (codapi)" section: the standing service + shared network + docker-socket (not privileged); the arm64/codapi rationale (Piston/Judge0 die on this host — link the spec); `make codapi` (builds sandbox images + server image, runs codapi); the docker-outside-of-docker `TMPDIR`-matched mount; `code-cli` as the credential-less scoped boundary (raw fetch, `Bash(code-cli *)`, `code` in `SKILL_SRCS`/`BAKED_SKILL_NAMES`); the **offline** property and that per-run maxima are enforced in `codapi.json`; the **honest boundary** note (the codapi API is unauthenticated and reachable other ways — browser `eval` — so worst case is offline capped execution, never host; the socket-holding-codapi residual risk). Mirror the spec's Security posture.

- [ ] **Step 3: End-to-end**

With `make codapi` up and the app on the network:
1. `make discord` (or `make run`); send a message asking Baxter to "compute the mean of [2,4,6] with numpy and tell me". Confirm the log shows a `code-cli python` call and he reports `4`.
2. Ask him to save that as a script and re-run it — confirm a `.py` appears in `memory-workspace` and re-runs via `--file`.
3. Confirm an offline attempt (ask him to fetch a URL *inside* code) fails and he falls back to WebFetch/browser for fetching.

- [ ] **Step 4: Commit**
```bash
git add app/.env.example app/CLAUDE.md
git commit -m "Document the codapi code sandbox (.env.example, CLAUDE.md)"
```

---

## Self-Review

**Spec coverage:**
- codapi standing service (server image, socket, TMPDIR mount) + shared network + sandbox images → Task 1. ✓
- Offline execution + enforced maxima in `codapi.json` → Task 1 (config) + Task 1 Step 5 (offline check) + Task 6. ✓
- Curated libs baked into sandbox images (no HTTP clients) → Task 1. ✓
- `code-cli` boundary (stdin/`--file`, REST, error handling; no version resolution) → Tasks 2–3. ✓
- `Bash(code-cli *)`, `SKILL_SRCS`, `"code"` in `BAKED_SKILL_NAMES`, shim → Task 5. ✓
- `code` skill (lands before wiring) + prompt lines → Tasks 4–5. ✓
- Save/reuse loop → Task 5 prompt line + Task 6 e2e. ✓
- Honest-boundary + residual-risk (socket, not privileged) docs → Task 6. ✓

**Carried-over review fixes:** network-ensure on `run`/`discord` (Task 1 Step 4); reachability hint fires only on connection errors, no empty-alternation regex (Task 3 Step 1); skill lands before its `SKILL_SRCS` wiring (Task 4 before Task 5); no dangling `.env` knobs — limits live in `codapi.json` (Task 6 Step 1).

**Placeholder scan:** The only literal fill-ins are the codapi tarball SHA-256 (Task 1 Steps 3–4, obtained by `curl … | sha256sum`) — a concrete value fetched during Task 1, not an unfilled design decision. Every code step shows code.

**Type consistency:** `parseArgs`→`{lang,file}`, `buildRequestBody({sandbox,content})`→`{sandbox,command,files}`, `formatResult({ok,stdout,stderr})`, `SANDBOXES` set, `execute({sandbox,content})` — names/shapes match across Tasks 2 and 3. Sandbox names (`python`/`node`) are consistent across `codapi/sandboxes/*`, `SANDBOXES`, and the skill.
