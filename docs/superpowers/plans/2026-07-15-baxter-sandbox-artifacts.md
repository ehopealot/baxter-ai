# Baxter Sandbox Artifacts + Discord Attachments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Baxter generate media (charts/images/PDF/audio) in the offline codapi sandbox, return the files to his workspace, and post them as Discord attachments.

**Architecture:** A wrapper in the sandbox base64-emits any file the program writes to `/tmp/artifacts`, framed by a random boundary that the trusted `code-cli` mints and passes in as an extra file (so an attacker-influenced program can't forge a frame). `code-cli` splits the frames off stdout, sanitizes names, size-checks, and writes real files into `<cwd>/artifacts/`. `discord-cli` gains `--file` for multipart upload.

**Tech Stack:** Node 22 (ESM), codapi HTTP API, `python:3.12-slim` sandbox (+ Pillow/matplotlib/reportlab), a POSIX `sh` wrapper, Discord REST v10 multipart, `node:test`.

## Global Constraints

- **The sandbox is read-only** (verified: writing `/tmp/x` fails `Errno 30`). The feature requires a **bounded writable tmpfs** at `/tmp` in `codapi.json` (`tmpfs: ["/tmp:size=32m,mode=1777"]`) — ephemeral, in-memory, size-capped, so the offline/read-only-rootfs posture is preserved (only a scratch dir is writable).
- **Random boundary, minted by the trusted side.** `code-cli` generates a per-run boundary and passes it to the sandbox as the extra file `.artifact_boundary` (verified: codapi delivers extra files from the `files` map to `/sandbox/`). The running program never sees it, so it cannot forge a frame. Same pattern as the transcript-forgery trigger marker.
- **Frame format (line-based, `base64 -w0` single line per artifact):**
  ```
  <program stdout…>
  <BOUNDARY> ARTIFACT <size> <name>
  <base64-no-wrap>
  <BOUNDARY> END
  <BOUNDARY> TOOBIG <size> <name>
  ```
  `size` first (a single integer token), `name` is the rest of the line (may contain spaces; `code-cli` sanitizes to a basename). `base64 -w0` confirmed available (`/usr/bin/base64`, GNU coreutils).
- **Size caps:** per-artifact **8 MB** (`MAX_ARTIFACT_BYTES=8388608`), plus a cumulative **10 MB** budget per run; over either → a `TOOBIG` frame (no bytes). `codapi.json` `noutput` raised to **16000000** so framed base64 is never truncated. `memory` raised to **512** (tmpfs + matplotlib + encode buffer).
- **Filename sanitization (load-bearing):** artifact names come from inside the sandbox (attacker-influenceable). `code-cli` takes the **basename only**, rejects empty / `.` / `..` / absolute, and writes ONLY under `<cwd>/artifacts/`.
- **Send side is Discord-only.** Email attachments are a separate future spec — do not touch `gmail.mjs`.
- **Entry-point guards** stay as-is (`pathToFileURL(process.argv[1]).href === import.meta.url`) so tests import pure helpers without running the CLI.
- **Running unit tests:** `node --test` **inside the built `app-app` image** via the throwaway-container `docker cp` pattern (see Task 2 Step 4). (Dev/host image tag is `<project>-app`; in this dev container that's `app-app`.)
- **Commit trailers:** end each commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_013R7GwxgVf6Rg1T1Yvr7rZg`.

---

## File Structure

**Created:**
- `app/sandboxes/emit-artifacts.sh` — the wrapper; baked into both sandbox images, becomes the `run` command.

**Modified:**
- `app/codapi/codapi.json` — tmpfs, `noutput`, `memory`.
- `app/sandboxes/python/Dockerfile` — Pillow, matplotlib, reportlab; COPY the wrapper.
- `app/sandboxes/node/Dockerfile` — COPY the wrapper.
- `app/codapi/sandboxes/python/commands.json`, `.../node/commands.json` — run via the wrapper.
- `app/scripts/code-cli.mjs` (+`.test.mjs`) — boundary mint, frame parse, name sanitize, decode+write, summary.
- `app/scripts/discord-cli.mjs` (+`.test.mjs`) — `--file` multipart on send/reply/send-thread.
- `app/prompt.md`, `app/discord-prompt.md`, `app/skills/code/SKILL.md`, `app/skills/discord/SKILL.md`, `app/CLAUDE.md` — document the loop.

---

## Task 1: Sandbox side — writable scratch, media libs, artifact wrapper (controller-run; Docker-heavy)

**Files:**
- Create: `app/sandboxes/emit-artifacts.sh`
- Modify: `app/codapi/codapi.json`, `app/sandboxes/python/Dockerfile`, `app/sandboxes/node/Dockerfile`, `app/codapi/sandboxes/python/commands.json`, `app/codapi/sandboxes/node/commands.json`

**Interfaces:**
- Produces: a sandbox where a program writing files to `/tmp/artifacts` gets them emitted on stdout as boundary-framed `base64 -w0`, using the boundary from `/sandbox/.artifact_boundary`; Python has Pillow/matplotlib/reportlab.

- [ ] **Step 1: The wrapper** `app/sandboxes/emit-artifacts.sh`
```sh
#!/bin/sh
# codapi runs this as the sandbox's `run` command: `emit-artifacts.sh <interp> main.<ext>`.
# It runs the program, then base64-emits any files the program wrote to
# /tmp/artifacts, framed by the random boundary the trusted caller (code-cli)
# supplied in /sandbox/.artifact_boundary. The program never sees the boundary,
# so it cannot forge a frame. Per-artifact and cumulative size caps prevent a
# run from overflowing codapi's stdout cap (noutput) into truncated base64.
set -u
ART=/tmp/artifacts
mkdir -p "$ART" 2>/dev/null || true
"$@"                       # run the program verbatim; preserve its stdout/stderr
status=$?
B=$(cat /sandbox/.artifact_boundary 2>/dev/null || true)
[ -n "$B" ] || exit $status
MAX=${MAX_ARTIFACT_BYTES:-8388608}      # 8 MB per artifact
BUDGET=${MAX_TOTAL_BYTES:-10485760}     # 10 MB cumulative
used=0
printf '\n'                             # guarantee frames start on a fresh line
for f in "$ART"/*; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  size=$(wc -c < "$f" | tr -d ' ')
  used=$((used + size))
  if [ "$size" -gt "$MAX" ] || [ "$used" -gt "$BUDGET" ]; then
    printf '%s TOOBIG %s %s\n' "$B" "$size" "$name"
    continue
  fi
  printf '%s ARTIFACT %s %s\n' "$B" "$size" "$name"
  base64 -w0 "$f"
  printf '\n%s END\n' "$B"
done
exit $status
```

- [ ] **Step 2: `codapi.json`** — add tmpfs, raise caps. Change the `box` and `step` blocks so `box` includes `"tmpfs": ["/tmp:size=32m,mode=1777"]` and `"memory": 512`, and `step` sets `"noutput": 16000000`. Full file:
```json
{
    "pool_size": 8,
    "verbose": true,
    "box": {
        "runtime": "runc",
        "cpu": 1,
        "memory": 512,
        "network": "none",
        "writable": false,
        "volume": "%s:/sandbox:ro",
        "cap_drop": ["all"],
        "ulimit": ["nofile=96"],
        "nproc": 64,
        "tmpfs": ["/tmp:size=32m,mode=1777"]
    },
    "step": {
        "user": "sandbox",
        "action": "run",
        "timeout": 15,
        "noutput": 16000000
    }
}
```
(Timeout bumped 10→15s; matplotlib import + render is heavier than plain compute.)

- [ ] **Step 3: Python Dockerfile** `app/sandboxes/python/Dockerfile` — add libs + the wrapper + a matplotlib config forcing the offline Agg backend and a writable config dir:
```dockerfile
FROM python:3.12-slim
RUN adduser --home /sandbox --disabled-password --gecos "" sandbox \
 && pip install --no-cache-dir numpy pandas python-dateutil beautifulsoup4 \
      pillow matplotlib reportlab
# Headless, file-only backend. Point matplotlib's config/cache at the writable
# tmpfs (/tmp is the only writable path at runtime under the read-only rootfs),
# so it can build its font cache per run without hitting the read-only FS. Fail
# the build early if any media lib is broken on this arch.
ENV MPLBACKEND=Agg MPLCONFIGDIR=/tmp/matplotlib
RUN python -c "import matplotlib.pyplot, PIL, reportlab; print('media libs ok')"
COPY emit-artifacts.sh /usr/local/bin/emit-artifacts.sh
RUN chmod +x /usr/local/bin/emit-artifacts.sh
USER sandbox
WORKDIR /sandbox
```
(The build context is `app/sandboxes/python`, so `COPY emit-artifacts.sh` needs the file there — Step 5 handles placement.)

- [ ] **Step 4: Node Dockerfile** `app/sandboxes/node/Dockerfile` — add the wrapper (keep existing libs). After the existing `RUN npm install …`/`ENV NODE_PATH…` lines and before `USER sandbox`, add:
```dockerfile
COPY emit-artifacts.sh /usr/local/bin/emit-artifacts.sh
RUN chmod +x /usr/local/bin/emit-artifacts.sh
```

- [ ] **Step 5: Make the wrapper available to both build contexts.** The two Dockerfiles have different build contexts (`app/sandboxes/python`, `app/sandboxes/node`). Keep one source of truth and copy it into each context in the `codapi` make target (Step 7), OR commit a copy in each dir. Chosen: **single source** `app/sandboxes/emit-artifacts.sh`, and the `codapi` target copies it into each context before building. Edit the `Makefile` `codapi` target: before the `docker build -t codapi/python …` line, add:
```makefile
	cp app/sandboxes/emit-artifacts.sh app/sandboxes/python/emit-artifacts.sh
	cp app/sandboxes/emit-artifacts.sh app/sandboxes/node/emit-artifacts.sh
```
Add `app/sandboxes/*/emit-artifacts.sh` to `.gitignore` (the copies are build artifacts; the source of truth is `app/sandboxes/emit-artifacts.sh`).

- [ ] **Step 6: commands.json** — run via the wrapper. `app/codapi/sandboxes/python/commands.json`:
```json
{
    "run": {
        "engine": "docker",
        "entry": "main.py",
        "steps": [
            { "box": "python", "command": ["emit-artifacts.sh", "python", "main.py"] }
        ]
    }
}
```
`app/codapi/sandboxes/node/commands.json`: same shape, `entry: "main.js"`, `command: ["emit-artifacts.sh", "node", "main.js"]`, `box: "node"`.

- [ ] **Step 7: Rebuild and bring up**
```bash
make codapi   # (from the dev container: names are app-*; add PROJECT=baxter on the host)
sleep 3
```

- [ ] **Step 8: Verify the sandbox emits framed artifacts (matplotlib PNG)**
```bash
docker run --rm --network app-net curlimages/curl -s --max-time 60 -X POST http://codapi:1313/v1/exec \
  -H 'content-type: application/json' \
  -d '{"sandbox":"python","command":"run","files":{".artifact_boundary":"BOUND-xyz","":"import matplotlib.pyplot as plt\nplt.plot([1,2,3],[1,4,9])\nplt.savefig(\"/tmp/artifacts/chart.png\")\nprint(\"done\")"}}' \
  | head -c 300
```
Expected: JSON `ok:true`; `stdout` contains `done`, then a line `BOUND-xyz ARTIFACT <size> chart.png`, a base64 blob, and `BOUND-xyz END`. (If `ok:false` with a tmpfs/permission error, the tmpfs mode/size in Step 2 is wrong — fix and rebuild.)

- [ ] **Step 9: Verify offline + a Pillow image + a WAV** (same call shape, bodies: a Pillow `Image.new(...).save("/tmp/artifacts/x.png")`; a stdlib `wave` writing `/tmp/artifacts/tone.wav`). Confirm each yields an `ARTIFACT` frame.

- [ ] **Step 10: Commit**
```bash
git add app/sandboxes app/codapi/codapi.json app/codapi/sandboxes Makefile .gitignore
git commit -m "Sandbox artifacts: tmpfs scratch, media libs, base64-frame wrapper"
```

---

## Task 2: `code-cli` artifact parsing (pure helpers, TDD)

**Files:**
- Modify: `app/scripts/code-cli.mjs`, `app/scripts/code-cli.test.mjs`

**Interfaces:**
- Produces:
  - `sanitizeArtifactName(name)` → safe basename string; throws on empty/`.`/`..`/absolute/traversal.
  - `parseArtifacts(stdout, boundary)` → `{ output: string, artifacts: [{ name, size, b64 }], tooBig: [{ name, size }] }` — splits the program's own stdout from the boundary frames.
  - `formatBytes(n)` → e.g. `"142 KB"`.

- [ ] **Step 1: Write failing tests** — append to `app/scripts/code-cli.test.mjs`:
```js
import { sanitizeArtifactName, parseArtifacts, formatBytes } from "./code-cli.mjs";

test("sanitizeArtifactName keeps a basename, rejects traversal/absolute/empty", () => {
  assert.equal(sanitizeArtifactName("chart.png"), "chart.png");
  assert.equal(sanitizeArtifactName("my chart.png"), "my chart.png");
  for (const bad of ["", ".", "..", "../x", "/etc/passwd", "a/b.png", "..\\x"]) {
    assert.throws(() => sanitizeArtifactName(bad), /invalid artifact name/);
  }
});

test("parseArtifacts splits program output from framed artifacts", () => {
  const B = "BOUND-abc";
  const b64 = Buffer.from("hello").toString("base64");
  const stdout = `line1\nline2\n\n${B} ARTIFACT 5 chart.png\n${b64}\n${B} END\n`;
  const r = parseArtifacts(stdout, B);
  assert.equal(r.output.trimEnd(), "line1\nline2");
  assert.equal(r.artifacts.length, 1);
  assert.equal(r.artifacts[0].name, "chart.png");
  assert.equal(r.artifacts[0].size, 5);
  assert.equal(r.artifacts[0].b64, b64);
  assert.equal(r.tooBig.length, 0);
});

test("parseArtifacts records TOOBIG frames and handles no artifacts", () => {
  const B = "BOUND-abc";
  assert.deepEqual(parseArtifacts("just output\n", B), { output: "just output\n", artifacts: [], tooBig: [] });
  const r = parseArtifacts(`\n${B} TOOBIG 99999999 big.bin\n`, B);
  assert.deepEqual(r.tooBig, [{ name: "big.bin", size: 99999999 }]);
});

test("parseArtifacts is not fooled by output that resembles a frame but lacks the real boundary", () => {
  const B = "BOUND-secret";
  const stdout = `FAKE ARTIFACT 5 evil.png\n${Buffer.from("x").toString("base64")}\nFAKE END\n`;
  const r = parseArtifacts(stdout, B);
  assert.equal(r.artifacts.length, 0);
  assert.match(r.output, /FAKE ARTIFACT/); // stays in program output, not parsed
});
```

- [ ] **Step 2: Run to confirm failure** — `docker run --rm app-app:latest node --test scripts/code-cli.test.mjs` → FAIL (exports missing).

- [ ] **Step 3: Implement** — add to `app/scripts/code-cli.mjs` (after `formatResult`):
```js
import { basename } from "node:path";

export function sanitizeArtifactName(name) {
  const trimmed = String(name).trim();
  const base = basename(trimmed);
  // basename() silently strips leading path components ("../x" -> "x",
  // "/etc/passwd" -> "passwd"); a `base !== trimmed` mismatch means the input
  // carried a directory component and must be rejected, not quietly truncated.
  if (!base || base === "." || base === ".." || base !== trimmed || base.includes("\\") || /^[A-Za-z]:/.test(base)) {
    throw new Error(`invalid artifact name: ${JSON.stringify(name)}`);
  }
  return base;
}

const KB = 1024;
export function formatBytes(n) {
  if (n < KB) return `${n} B`;
  if (n < KB * KB) return `${Math.round(n / KB)} KB`;
  return `${(n / (KB * KB)).toFixed(1)} MB`;
}

// Split the program's own stdout from the boundary-framed artifact blocks the
// sandbox wrapper appended. `boundary` was minted by us and handed to the
// sandbox, so program output can't contain a real frame line.
export function parseArtifacts(stdout, boundary) {
  const lines = stdout.split("\n");
  const outputLines = [];
  const artifacts = [];
  const tooBig = [];
  const A = `${boundary} ARTIFACT `;
  const T = `${boundary} TOOBIG `;
  const END = `${boundary} END`;
  let i = 0;
  let inFrames = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(A)) {
      inFrames = true;
      const rest = line.slice(A.length);
      const sp = rest.indexOf(" ");
      const size = Number(rest.slice(0, sp));
      const name = rest.slice(sp + 1);
      const b64 = lines[++i] ?? "";
      // next line should be END; tolerate and continue
      if ((lines[i + 1] ?? "") === END) i++;
      artifacts.push({ name, size, b64 });
    } else if (line.startsWith(T)) {
      inFrames = true;
      const rest = line.slice(T.length);
      const sp = rest.indexOf(" ");
      tooBig.push({ size: Number(rest.slice(0, sp)), name: rest.slice(sp + 1) });
    } else if (!inFrames) {
      outputLines.push(line);
    }
  }
  return { output: outputLines.join("\n"), artifacts, tooBig };
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
Expected: all tests pass (the 5 existing + 4 new = 9).

- [ ] **Step 5: Commit**
```bash
git add app/scripts/code-cli.mjs app/scripts/code-cli.test.mjs
git commit -m "Add code-cli artifact frame parsing + name sanitizer (tests)"
```

---

## Task 3: `code-cli` — mint boundary, return artifacts to the workspace

**Files:**
- Modify: `app/scripts/code-cli.mjs`

**Interfaces:**
- Consumes: `buildRequestBody` (extended), `parseArtifacts`, `sanitizeArtifactName`, `formatBytes` (Task 2); a running sandbox with the wrapper (Task 1).
- Produces: `code-cli python|node` now writes any produced artifacts to `<cwd>/artifacts/<name>` and prints a summary; program output is shown without the frames.

- [ ] **Step 1: Extend `buildRequestBody` to carry the boundary file.** Change its signature to `buildRequestBody({ sandbox, content, boundary })` and body to include the extra file:
```js
export function buildRequestBody({ sandbox, content, boundary }) {
  const files = { "": content };
  if (boundary) files[".artifact_boundary"] = boundary;
  return { sandbox, command: "run", files };
}
```
Update the existing Task-2-era test `buildRequestBody assembles a codapi /v1/exec request` to pass `boundary: undefined` and still expect `{ sandbox, command:"run", files:{ "": ... } }` (no boundary key when falsy). Add one assertion: with `boundary:"B"`, `files[".artifact_boundary"] === "B"`.

- [ ] **Step 2: Mint the boundary and handle artifacts in `execute`/dispatch.** Replace the `execute` function and the dispatch's success path:
```js
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function execute({ sandbox, content }) {
  const boundary = `BAX-${randomUUID()}`;
  const res = await fetch(`${CODAPI_URL}/v1/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildRequestBody({ sandbox, content, boundary })),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`codapi /v1/exec -> ${res.status}: ${text}`);
  return { result: JSON.parse(text), boundary };
}

// Decode framed artifacts into <cwd>/artifacts and return summary lines.
function writeArtifacts(parsed) {
  const notes = [];
  if (parsed.artifacts.length) {
    const dir = join(process.cwd(), "artifacts");
    mkdirSync(dir, { recursive: true });
    for (const a of parsed.artifacts) {
      const name = sanitizeArtifactName(a.name);
      const buf = Buffer.from(a.b64, "base64");
      if (buf.length !== a.size) { notes.push(`[artifact ${name} corrupt: ${buf.length}≠${a.size} bytes, skipped]`); continue; }
      writeFileSync(join(dir, name), buf);
      notes.push(`[wrote artifacts/${name} (${formatBytes(buf.length)})]`);
    }
  }
  for (const t of parsed.tooBig) notes.push(`[artifact ${sanitizeArtifactName(t.name)} too big (${formatBytes(t.size)}), not returned]`);
  return notes;
}
```
Then in the dispatch, after `const { result, boundary } = await execute(...)`:
```js
const parsed = parseArtifacts(result.stdout || "", boundary);
const notes = writeArtifacts(parsed);
console.log(formatResult({ ...result, stdout: parsed.output }));
if (notes.length) console.log(notes.join("\n"));
```
(Adjust the destructuring at the `execute` call site: `const { result, boundary } = await execute({ sandbox: opts.lang, content });` then use the two lines above instead of `console.log(formatResult(result))`.)

- [ ] **Step 3: Regression + integration.** Rebuild; run the unit tests (docker-cp pattern) — still all pass. Then integration (codapi up):
```bash
printf 'import matplotlib.pyplot as plt\nplt.plot([1,2,3],[1,4,9])\nplt.savefig("/tmp/artifacts/chart.png")\nprint("plotted")\n' | \
  docker run --rm -i --network app-net -e CODAPI_URL=http://codapi:1313 \
  -v "$(docker inspect "$(hostname)" --format '{{range .Mounts}}{{if eq .Destination "/app"}}{{.Source}}{{end}}{{end}}')/app/scripts/code-cli.mjs:/app/scripts/code-cli.mjs" \
  -w /work app-app:latest code-cli python
```
Expected: `plotted`, `[ok]`, `[wrote artifacts/chart.png (… KB)]`, and `/work/artifacts/chart.png` exists in the container run (verify by listing in a wrapping `sh -c`). Also test a crafted name: code that saves `/tmp/artifacts/x.png` then the wrapper reports basename — confirm a name like `..%2f` can't escape (sanitize covers it; the wrapper's `basename` also strips paths).

- [ ] **Step 4: Commit**
```bash
git add app/scripts/code-cli.mjs
git commit -m "code-cli: mint boundary, return sandbox artifacts to workspace"
```

---

## Task 4: `discord-cli --file` attachments

**Files:**
- Modify: `app/scripts/discord-cli.mjs`, `app/scripts/discord-cli.test.mjs`

**Interfaces:**
- Consumes: `parseFlags`, `sendMessage`, `api` (existing).
- Produces: `extractFiles(args)` → `{ files: string[], rest: string[] }`; `buildAttachmentPayload(content, extra, filenames)` → the `payload_json` object; `send`/`reply`/`send-thread` accept repeatable `--file <path>`.

- [ ] **Step 1: Failing tests** — append to `app/scripts/discord-cli.test.mjs`:
```js
import { extractFiles, buildAttachmentPayload } from "./discord-cli.mjs";

test("extractFiles pulls every --file, leaving the rest", () => {
  assert.deepEqual(extractFiles(["123", "--file", "a.png", "--file", "b.wav"]),
    { files: ["a.png", "b.wav"], rest: ["123"] });
  assert.deepEqual(extractFiles(["123", "456"]), { files: [], rest: ["123", "456"] });
  assert.throws(() => extractFiles(["--file"]), /missing value for --file/);
});

test("buildAttachmentPayload lists attachments with sequential ids + basenames", () => {
  const p = buildAttachmentPayload("hi", { message_reference: { message_id: "9" } }, ["/w/artifacts/chart.png", "/w/t.wav"]);
  assert.equal(p.content, "hi");
  assert.deepEqual(p.message_reference, { message_id: "9" });
  assert.deepEqual(p.attachments, [{ id: 0, filename: "chart.png" }, { id: 1, filename: "t.wav" }]);
});
```

- [ ] **Step 2: Run to confirm failure** (docker-cp pattern on `discord-cli.test.mjs`).

- [ ] **Step 3: Implement `extractFiles` + `buildAttachmentPayload`** — add near `parseFlags`:
```js
import { basename } from "node:path";

// Pull every `--file <path>` out of args (parseFlags keeps only the last of a
// repeated flag), returning the paths and the remaining args for parseFlags.
export function extractFiles(args) {
  const files = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file") {
      if (i + 1 >= args.length) throw new Error("missing value for --file");
      files.push(args[++i]);
    } else rest.push(args[i]);
  }
  return { files, rest };
}

export function buildAttachmentPayload(content, extra, filePaths) {
  return {
    content,
    ...extra,
    attachments: filePaths.map((p, id) => ({ id, filename: basename(p) })),
  };
}
```

- [ ] **Step 4: Multipart send.** Extend `api` to pass a `FormData` body through untouched, and add a file-aware send. In `api`, replace the `headers`/`body` construction so a `FormData` body is sent without a JSON content-type:
```js
    const isForm = body instanceof FormData;
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token()}`,
        "User-Agent": "BaxterBurgundy (https://example.invalid, 1.0)",
        ...(isForm ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
```
Add a helper that posts one message with attachments (single message — Discord attaches to one post):
```js
import { readFileSync } from "node:fs"; // already imported at top; do not duplicate

async function sendWithFiles(channelId, content, extra, filePaths) {
  const { count } = loadDiscordSendState();
  if (count >= DISCORD_MAX_SENDS_PER_DAY) throw new Error(`Discord daily send cap reached (${count}/${DISCORD_MAX_SENDS_PER_DAY}); message not sent`);
  const MAX = 25 * 1024 * 1024;
  const bufs = filePaths.map((p) => {
    let buf;
    try { buf = readFileSync(p); } catch { throw new Error(`--file not readable: ${p}`); }
    if (buf.length > MAX) throw new Error(`--file too large for Discord (${p}, ${buf.length} bytes > 25MB)`);
    return buf;
  });
  recordDiscordSend();
  const form = new FormData();
  form.append("payload_json", JSON.stringify(buildAttachmentPayload(content, extra, filePaths)));
  bufs.forEach((buf, i) => form.append(`files[${i}]`, new Blob([buf]), basename(filePaths[i])));
  return api("POST", `/channels/${channelId}/messages`, form);
}
```

- [ ] **Step 5: Wire the commands.** In the dispatch, extract files first, then parse the rest, and route send/reply/send-thread to `sendWithFiles` when files are present. Replace the top of the dispatch and the three cases:
```js
  const { files, rest: restArgs } = extractFiles(rest);
  const { positionals, flags } = parseFlags(restArgs);
  // …
      case "send":
        console.log(JSON.stringify(files.length
          ? await sendWithFiles(positionals[0], await readStdin(), {}, files)
          : await sendMessage(positionals[0], await readStdin())));
        break;
      case "reply": {
        const extra = { message_reference: { message_id: positionals[1] } };
        const body = await readStdin();
        console.log(JSON.stringify(files.length
          ? await sendWithFiles(positionals[0], body, extra, files)
          : await sendMessage(positionals[0], body, extra)));
        break;
      }
      case "send-thread":
        console.log(JSON.stringify(files.length
          ? await sendWithFiles(positionals[0], await readStdin(), {}, files)
          : await sendMessage(positionals[0], await readStdin())));
        break;
```
Note: with `--file`, content may be empty (attach-only) — `readStdin()` returning `""` is fine; Discord accepts a message with attachments and empty content. Content over 2000 chars alongside files is the caller's concern (rare); `sendWithFiles` posts a single message (no chunking) — if content exceeds 2000 Discord will 400, surfaced as a clear API error.

- [ ] **Step 6: Run tests + confirm no membership surface changed.** docker-cp unit tests pass; `grep -n 'files\[' app/scripts/discord-cli.mjs` shows only the attachment code.

- [ ] **Step 7: Commit**
```bash
git add app/scripts/discord-cli.mjs app/scripts/discord-cli.test.mjs
git commit -m "discord-cli: --file attachments (multipart) on send/reply/send-thread"
```

---

## Task 5: Prompts, skills, docs

**Files:**
- Modify: `app/skills/code/SKILL.md`, `app/skills/discord/SKILL.md`, `app/prompt.md`, `app/discord-prompt.md`, `app/CLAUDE.md`

- [ ] **Step 1: `code` skill** — add an "Artifacts (files out)" section: save media to `/tmp/artifacts/<name>` in your code; `code-cli` returns each file to `artifacts/<name>` in your working directory and prints `[wrote artifacts/<name> (size)]`; offline still applies; per-file cap 8 MB (bigger → `[… too big …]`).

- [ ] **Step 2: `code` skill + prompts** — add the share loop: after generating, attach with `discord-cli … --file artifacts/<name>` (Discord side). One example end-to-end (plot → savefig → code-cli → discord-cli reply --file).

- [ ] **Step 3: `discord` skill** — document `--file <path>` (repeatable) on `send`/`reply`/`send-thread`: uploads a workspace file as an attachment; ≤25 MB; counts as one send.

- [ ] **Step 4: `app/prompt.md` + `app/discord-prompt.md`** — one line under the code-cli bullet: "Code can produce files (charts/images/PDF/audio): save to `/tmp/artifacts/…`; they come back as `artifacts/…` in your workspace, and on Discord you can attach them with `discord-cli … --file artifacts/…`."

- [ ] **Step 5: `app/CLAUDE.md`** — under the codapi section, an "Artifacts" note: tmpfs scratch, the random-boundary framing (trusted `code-cli` mints it), size caps, `discord-cli --file`. Cross-reference the spec.

- [ ] **Step 6: Commit**
```bash
git add app/skills app/prompt.md app/discord-prompt.md app/CLAUDE.md
git commit -m "Document sandbox artifacts + discord --file loop"
```

---

## Task 6: End-to-end verification

**Files:** none (verification).

- [ ] **Step 1: Rebuild the app image + restart the live daemon** with the new `code-cli`/`discord-cli` (in the dev env: `make build-app` then swap the `baxter-discord` container; or on the host, restart `make discord`). Ensure `make codapi` (Task 1) is up on the same network.

- [ ] **Step 2: Live e2e.** In Discord, ask Baxter to "plot y=x^2 and post it." Confirm the logs show `code-cli python` producing `[wrote artifacts/…]`, then `discord-cli reply … --file artifacts/…`, and the image appears as a real attachment in the channel.

- [ ] **Step 3: Failure path.** Ask him to generate something large / confirm a `[… too big …]` note is handled gracefully (he reports it rather than crashing).

- [ ] **Step 4:** No commit (verification only); note results in the progress ledger.

---

## Self-Review

**Spec coverage:**
- Media libs (Pillow/matplotlib/reportlab; WAV via stdlib) → Task 1. ✓
- Writable scratch (tmpfs) — required, verified read-only today → Task 1. ✓
- Base64-over-stdout + random trusted-minted boundary → wrapper (Task 1) + `code-cli` mint (Task 3). ✓
- Frame parse, name sanitization, size/integrity guards → Task 2 (parse/sanitize) + Task 3 (decode/size/integrity). ✓
- Artifacts land in `<cwd>/artifacts/` → Task 3. ✓
- `discord-cli --file` multipart, size guard, send-cap, single logical send → Task 4. ✓
- Docs (loop in prompts + both skills + CLAUDE.md) → Task 5. ✓
- Isolation unchanged (no network; only a bounded tmpfs added) → Task 1 config. ✓
- Email untouched → not in any task. ✓

**Placeholder scan:** Every code step has complete code; configs are full; the wrapper and both Dockerfiles are shown in full. No TODO/vague steps.

**Type consistency:** `parseArtifacts(stdout, boundary) → {output, artifacts:[{name,size,b64}], tooBig:[{name,size}]}` used consistently in Task 3's `writeArtifacts`. `buildRequestBody({sandbox,content,boundary})` extended in Task 3 and its Task-2 test updated. `extractFiles → {files, rest}` and `buildAttachmentPayload(content, extra, filePaths) → {content, …extra, attachments:[{id,filename}]}` match between Task 4 tests and impl. Boundary format `BAX-<uuid>` minted in Task 3 matches the wrapper reading `/sandbox/.artifact_boundary` in Task 1.
