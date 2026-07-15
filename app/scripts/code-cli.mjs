#!/usr/bin/env node
// Token-less boundary CLI for the offline codapi sandbox. The spawned claude
// run reaches code execution only through this (Bash(code-cli *)); no secret
// lives here -- it's a scoping/convenience layer over codapi's HTTP API. Raw
// fetch, no deps.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { basename } from "node:path";

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

export function sanitizeArtifactName(name) {
  const trimmed = String(name).trim();
  const base = basename(trimmed);
  // basename() silently strips any leading path components (e.g. "../x" -> "x",
  // "/etc/passwd" -> "passwd") instead of flagging them -- so a bare `base ===
  // trimmed` mismatch means the input carried a directory component and must be
  // rejected, not quietly truncated.
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
