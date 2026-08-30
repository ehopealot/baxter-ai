#!/usr/bin/env node
// Token-less boundary CLI for remote-only code execution. The spawned run reaches
// code only through this command; it has no signing key and talks to the local
// Unix signer (fleet) or explicit direct remote credential (self-hosted).
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveExecutionTransport, sendRemoteExecution } from "./code-executor-client.ts";

// Our language names are the remote runner's fixed interpreter names.
const SANDBOXES = new Set(["python", "node"]);

export interface ParsedArgs {
  lang: string;
  file: string | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [lang, ...rest] = argv;
  const opts: ParsedArgs = { lang, file: null };
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

// Remote /v1/exec response used by formatting and artifact parsing.
export interface CodeResult {
  id?: string;
  ok: boolean;
  duration?: number;
  stdout?: string;
  stderr?: string;
}

export function formatResult(res: CodeResult): string {
  const parts: string[] = [];
  if (res.stdout) parts.push(res.stdout.replace(/\n$/, ""));
  if (res.stderr) parts.push(`[stderr]\n${res.stderr.replace(/\n$/, "")}`);
  parts.push(res.ok ? "[ok]" : "[error]");
  return parts.join("\n");
}

export function sanitizeArtifactName(name: unknown): string {
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
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_ARTIFACT_BYTES = 10 * 1024 * 1024;
function isBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0) return false;
  const pad = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let i = 0; i < value.length - pad; i++) {
    const code = value.charCodeAt(i);
    const alphaNum = (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39);
    if (!alphaNum && code !== 0x2b && code !== 0x2f) return false;
  }
  for (let i = value.length - pad; i < value.length; i++) {
    if (value.charCodeAt(i) !== 0x3d) return false;
  }
  return true;
}

export function formatBytes(n: number): string {
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
export interface ArtifactFrame {
  name: string;
  size: number;
  b64: string;
}

export interface TooBigFrame {
  size: number;
  name: string;
}

export interface ParsedArtifacts {
  output: string;
  artifacts: ArtifactFrame[];
  tooBig: TooBigFrame[];
  malformed: number;
}

export function parseArtifacts(stdout: string, boundary: string): ParsedArtifacts {
  const lines = stdout.split("\n");
  const outputLines: string[] = [];
  const artifacts: ArtifactFrame[] = [];
  const tooBig: TooBigFrame[] = [];
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function execute({ sandbox, content, input }: { sandbox: string; content: string; input?: string }): Promise<{ result: CodeResult; boundary: string }> {
  const boundary = `BAX-${randomUUID()}`;
  const transport = resolveExecutionTransport();
  const result = await sendRemoteExecution({
    language: sandbox,
    source: content,
    ...(input === undefined ? {} : { input }),
    artifactBoundary: boundary,
  }, transport);
  return { result, boundary };
}

// Decode only a frame that is safe to materialize. Frame contents are untrusted:
// a program can read its boundary and forge them. Check declared size, encoded
// length, and alphabet before Buffer.from(), because Buffer.from() otherwise
// allocates attacker-sized data and tolerates malformed base64.
export function decodeArtifactFrame(a: ArtifactFrame): Buffer {
  if (!Number.isSafeInteger(a.size) || a.size < 0) throw new Error("invalid artifact size");
  if (a.size > MAX_ARTIFACT_BYTES) throw new Error("artifact exceeds 8 MiB");
  const maxEncodedBytes = Math.ceil(a.size / 3) * 4;
  if (Buffer.byteLength(a.b64, "utf8") > maxEncodedBytes) {
    throw new Error("artifact base64 exceeds declared size");
  }
  if (!isBase64(a.b64)) throw new Error("invalid artifact base64");
  const buf = Buffer.from(a.b64, "base64");
  if (buf.length !== a.size) throw new Error(`artifact corrupt: ${buf.length}≠${a.size} bytes`);
  return buf;
}

// Decode framed artifacts into <cwd>/artifacts and return summary lines. Frame
// contents (names, sizes, base64) are UNTRUSTED -- the sandbox program can read
// the boundary file and forge frames (see parseArtifacts) -- so every artifact
// is handled defensively: a bad name, size, encoding, or aggregate budget skips
// that one artifact with a note, never aborting the run or other artifacts.
export function writeArtifacts(
  parsed: ParsedArtifacts,
  dir = join(process.cwd(), "artifacts"),
): string[] {
  const notes: string[] = [];
  let totalArtifactBytes = 0;
  if (parsed.artifacts.length) {
    mkdirSync(dir, { recursive: true });
    for (const a of parsed.artifacts) {
      // The whole per-artifact body is guarded, not just sanitizeArtifactName --
      // a residual FS error (ENOSPC, a write failure on an otherwise-valid name)
      // must degrade to a skipped-artifact note, not abort the run/siblings.
      try {
        const name = sanitizeArtifactName(a.name);
        const buf = decodeArtifactFrame(a);
        if (totalArtifactBytes + buf.length > MAX_TOTAL_ARTIFACT_BYTES) {
          notes.push(`[artifact ${name} exceeds 10 MiB aggregate budget, skipped]`);
          continue;
        }
        writeFileSync(join(dir, name), buf);
        totalArtifactBytes += buf.length;
        notes.push(`[wrote artifacts/${name} (${formatBytes(buf.length)})]`);
      } catch (err) {
        notes.push(`[artifact ${JSON.stringify(a.name)} skipped: ${(err as Error).message}]`);
      }
    }
  }
  for (const t of parsed.tooBig) {
    let name: string;
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
      //
      // Two modes: without --file, stdin *is* the program (no room for data).
      // With --file, the program comes from the file and stdin is free to carry
      // input DATA -- so if anything is piped in (not an interactive TTY, and
      // non-empty), forward it to the sandbox as the `input` file. An empty pipe
      // (the daemon's usual no-data case) sends no input file, so a program that
      // doesn't expect one isn't handed a spurious empty file.
      let content: string;
      let input: string | undefined;
      if (opts.file) {
        content = readFileSync(opts.file, "utf8");
        if (!process.stdin.isTTY) {
          const piped = await readStdin();
          if (piped.length > 0) input = piped;
        }
      } else {
        content = await readStdin();
      }
      const { result, boundary } = await execute({ sandbox: opts.lang, content, input });
      const parsed = parseArtifacts(result.stdout || "", boundary);
      const notes = writeArtifacts(parsed);
      if (parsed.malformed > 0) notes.push(`[${parsed.malformed} artifact frame(s) malformed/truncated, dropped]`);
      console.log(formatResult({ ...result, stdout: parsed.output }));
      if (notes.length) console.log(notes.join("\n"));
    } catch (err) {
      // Infrastructure failure is distinct from code that ran and errored (the
      // latter returns a normal `{ ok: false }` result). There is no host fallback.
      const connFailed = /ECONNREFUSED|EAI_AGAIN|fetch failed/i.test(String(err));
      console.error(`code-cli: ${(err as Error).message}${connFailed ? " (is the remote executor signer up?)" : ""}`);
      process.exit(1);
    }
  })();
}
