#!/usr/bin/env node
// Token-less boundary CLI for the offline codapi sandbox. The spawned claude
// run reaches code execution only through this (Bash(code-cli *)); no secret
// lives here -- it's a scoping/convenience layer over codapi's HTTP API. Raw
// fetch, no deps.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

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
    } else {
      // Reject anything else (a stray positional like `code-cli python foo.py`,
      // or a typo'd flag) rather than silently ignoring it and reading stdin --
      // in the daemon's empty stdin that would "succeed" running nothing.
      throw new Error(`unknown argument: ${rest[i]}`);
    }
  }
  return opts;
}

export function buildRequestBody({ sandbox, content, boundary }) {
  const files = { "": content };
  if (boundary) files[".artifact_boundary"] = boundary;
  return { sandbox, command: "run", files };
}

// codapi /v1/exec response: { id, ok, duration, stdout, stderr }.
export function formatResult(res) {
  const parts = [];
  if (res.stdout) parts.push(res.stdout.replace(/\n$/, ""));
  if (res.stderr) parts.push(`[stderr]\n${res.stderr.replace(/\n$/, "")}`);
  parts.push(res.ok ? "[ok]" : "[error]");
  return parts.join("\n");
}

export function sanitizeArtifactName(name) {
  const trimmed = String(name).trim();
  const base = basename(trimmed);
  // basename() silently strips any leading path components (e.g. "../x" -> "x",
  // "/etc/passwd" -> "passwd") instead of flagging them -- so a bare `base ===
  // trimmed` mismatch means the input carried a directory component and must be
  // rejected, not quietly truncated. A forged frame (see parseArtifacts) can
  // also carry a NUL byte or an overlong name -- both pass basename() unscathed
  // yet make writeFileSync throw synchronously, so reject them here rather than
  // at the write site.
  if (!base || base === "." || base === ".." || base !== trimmed || base.includes("\\") ||
      /^[A-Za-z]:/.test(base) || /[\x00-\x1f\x7f]/.test(base) || Buffer.byteLength(base) > 255) {
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
// sandbox wrapper appended. The random boundary prevents ACCIDENTAL collisions
// (a program coincidentally printing frame-like text). It is NOT authentication:
// the boundary is delivered to the sandbox as a readable file, so a hostile
// program can read it and forge frames -- everything parsed here is untrusted,
// and writeArtifacts sanitizes names + size-checks every frame on the host side.
// Frame acceptance is STRICT, not tolerant: a truncated frame (missing END), a
// header cut before the name, or a filename containing a newline (splitting
// the header across lines) must not silently produce a garbage artifact --
// each of those instead bumps `malformed` and consumes only the header line,
// so the next real ARTIFACT/TOOBIG/END header re-anchors correctly (a stray
// non-header line encountered while inFrames is dropped, same as before).
export function parseArtifacts(stdout, boundary) {
  const lines = stdout.split("\n");
  const outputLines = [];
  const artifacts = [];
  const tooBig = [];
  let malformed = 0;
  const A = `${boundary} ARTIFACT `;
  const T = `${boundary} TOOBIG `;
  const END = `${boundary} END`;
  let inFrames = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(A)) {
      inFrames = true;
      const rest = line.slice(A.length);
      const sp = rest.indexOf(" ");
      const size = sp > 0 ? Number(rest.slice(0, sp)) : NaN;
      const name = sp > 0 ? rest.slice(sp + 1) : "";
      if (sp > 0 && Number.isInteger(size) && size >= 0 && name !== "" && lines[i + 2] === END) {
        artifacts.push({ name, size, b64: lines[i + 1] });
        i += 2; // consume the base64 line + the END line
      } else {
        malformed++; // consume only the header line -- do not over-consume
      }
    } else if (line.startsWith(T)) {
      inFrames = true;
      const rest = line.slice(T.length);
      const sp = rest.indexOf(" ");
      const size = sp > 0 ? Number(rest.slice(0, sp)) : NaN;
      if (sp > 0 && Number.isInteger(size)) {
        tooBig.push({ size, name: rest.slice(sp + 1) });
      } else {
        malformed++;
      }
    } else if (line === END) {
      // A bare END with no open frame (or the END already consumed above via
      // i += 2) carries no program output either way -- ignored.
    } else if (!inFrames) {
      outputLines.push(line);
    }
  }
  return { output: outputLines.join("\n"), artifacts, tooBig, malformed };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

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

// Decode framed artifacts into <cwd>/artifacts and return summary lines. Frame
// contents (names, sizes, base64) are UNTRUSTED -- the sandbox program can read
// the boundary file and forge frames (see parseArtifacts) -- so every artifact
// is handled defensively: a bad name or a size mismatch skips that one artifact
// with a note, never aborting the run or the other artifacts.
function writeArtifacts(parsed) {
  const notes = [];
  if (parsed.artifacts.length) {
    const dir = join(process.cwd(), "artifacts");
    mkdirSync(dir, { recursive: true });
    for (const a of parsed.artifacts) {
      // The whole per-artifact body is guarded, not just sanitizeArtifactName --
      // a residual FS error (ENOSPC, a write failure on an otherwise-valid name)
      // must degrade to a skipped-artifact note, not abort the run/siblings.
      try {
        const name = sanitizeArtifactName(a.name);
        const buf = Buffer.from(a.b64, "base64");
        if (buf.length !== a.size) { notes.push(`[artifact ${name} corrupt: ${buf.length}≠${a.size} bytes, skipped]`); continue; }
        writeFileSync(join(dir, name), buf);
        notes.push(`[wrote artifacts/${name} (${formatBytes(buf.length)})]`);
      } catch (err) {
        notes.push(`[artifact ${JSON.stringify(a.name)} skipped: ${err.message}]`);
      }
    }
  }
  for (const t of parsed.tooBig) {
    let name;
    try { name = sanitizeArtifactName(t.name); } catch { name = JSON.stringify(t.name); }
    notes.push(`[artifact ${name} too big (${formatBytes(t.size)}), not returned]`);
  }
  return notes;
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
      const { result, boundary } = await execute({ sandbox: opts.lang, content });
      const parsed = parseArtifacts(result.stdout || "", boundary);
      const notes = writeArtifacts(parsed);
      if (parsed.malformed > 0) notes.push(`[${parsed.malformed} artifact frame(s) malformed/truncated, dropped]`);
      console.log(formatResult({ ...result, stdout: parsed.output }));
      if (notes.length) console.log(notes.join("\n"));
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
