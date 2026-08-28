#!/usr/bin/env node
// memory-cli: CAS-protected access to Baxter's SHARED memory files -- memory.md and
// CREDENTIALS.md, which EVERY surface's run writes. Native Write/Edit leave a
// lost-update window (two runs read, then whole-file write, and the second silently
// clobbers the first); this closes it with the same compare-and-swap collections-cli
// uses (see cas-file.ts). Verbs:
//   read [target]              print the file to stdout; vends its version on stderr
//   append <target>            add stdin (lock-serialized, lossless, NO token) -- the
//                              zero-friction "record a fact" path
//   write <target> --expect V  replace the WHOLE file from stdin, atomically, iff version==V
// `target` is a FIXED allowlist -- `memory` (default) or `credentials` -- never an
// arbitrary path, so there's no traversal and it can't reach the sibling key files.
// The pure helpers take an explicit path so tests never touch the real workspace;
// the CLI resolves the real paths from paths.ts. Guarded so importing for tests
// doesn't run the CLI.
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { MEMORY_PATH, CREDENTIALS_PATH } from "./paths.ts";
import { versionToken, normalizeExpected, casSave, casAppend } from "./cas-file.ts";

const MAX_MEMORY_BYTES = 1024 * 1024; // 1 MB -- generous for markdown, same as collections

// Fixed name -> path allowlist. No arbitrary path input => no traversal (mirrors the
// confinement posture of files-cli/collections-cli). Exported (with an injectable map)
// so tests can exercise the resolver without the real paths.
const TARGETS: Record<string, string> = { memory: MEMORY_PATH, credentials: CREDENTIALS_PATH };
export function targetPath(target: string | undefined, targets: Record<string, string> = TARGETS): { name: string; path: string } {
  const name = String(target ?? "memory").toLowerCase();
  const path = targets[name];
  if (!path) throw new Error(`unknown memory target ${JSON.stringify(target)} -- use one of: ${Object.keys(targets).join(", ")}`);
  return { name, path };
}

// One read; ENOENT -> empty buffer (create-on-first-write), so a not-yet-written
// memory file reads as "" with the empty-buffer version, and a write with that
// version creates it.
export function readMemory(path: string): { buf: Buffer; version: string } {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") buf = Buffer.alloc(0);
    else throw err;
  }
  return { buf, version: versionToken(buf) };
}

function checkCap(len: number, name: string): void {
  if (len > MAX_MEMORY_BYTES) throw new Error(`${name} contents exceed the ${Math.round(MAX_MEMORY_BYTES / 1024)} KB cap`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const USAGE = [
  "usage:",
  "  memory-cli read [memory|credentials]        print the file (+ its version on stderr)",
  "  … | memory-cli append <memory|credentials>  add to it (lock-serialized, no token needed)",
  "  … | memory-cli write <target> --expect V    replace its WHOLE contents from stdin",
  "",
  "Shared across all your surfaces (email/Discord/heartbeat). To ADD a fact,",
  "`append` -- concurrent appends never clobber, so no version is needed. To REVISE,",
  "`read` it (note the version), edit, then `write --expect <version>`; if it changed",
  "under you since, the write is rejected -- re-read, reapply, write again. Keep it",
  "organized (fold appends into the right section) rather than letting it grow into",
  "an append log.",
].join("\n");

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "read") {
    if (rest.length > 1) throw new Error("usage: memory-cli read [memory|credentials]");
    const { path } = targetPath(rest[0]);
    const { buf, version } = readMemory(path);
    // stderr FIRST, so a head-truncated tool result never drops the token; the
    // `version:` line is CLI metadata, never part of the file body on stdout.
    process.stderr.write(`version: ${version}\n`);
    process.stdout.write(buf);
  } else if (cmd === "append") {
    if (rest.length !== 1) throw new Error("usage: … | memory-cli append <memory|credentials>");
    const { name, path } = targetPath(rest[0]);
    const body = await readStdin();
    mkdirSync(dirname(path), { recursive: true });
    // The MERGED-size cap is enforced inside casAppend (under the lock).
    const { version } = await casAppend(path, Buffer.from(body, "utf8"), MAX_MEMORY_BYTES);
    process.stderr.write(`version: ${version}\n`);
    console.log(`Appended to ${name}. New version: ${version}.`);
  } else if (cmd === "write") {
    // write <target> --expect <8hex>  (full contents on stdin). Order-tolerant flag.
    let target: string | null = null;
    let expected: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--expect") expected = rest[++i];
      else if (target === null) target = rest[i];
      else throw new Error("usage: … | memory-cli write <target> --expect <version>");
    }
    if (!target) throw new Error("usage: … | memory-cli write <memory|credentials> --expect <version>");
    const { name, path } = targetPath(target);
    const bodyBuf = Buffer.from(await readStdin(), "utf8");
    checkCap(bodyBuf.length, name);
    // Validate the token BEFORE the lock (argument-only).
    const supplied = normalizeExpected(expected, `run \`memory-cli read ${name}\` (or reuse the version from your last read/write), then write with it`);
    mkdirSync(dirname(path), { recursive: true });
    const { bytes, version } = await casSave(path, bodyBuf, supplied, name, "re-read it, reapply your change, and write with the new version");
    process.stderr.write(`version: ${version}\n`);
    console.log(`Wrote ${name} (${bytes} B). New version: ${version}.`);
  } else {
    console.error(USAGE);
    process.exit(cmd ? 1 : 2); // nonzero even with NO subcommand: exit-0-with-usage made run_cli report ok:true, so a model that misinvoked (cmd in stdin, no args) looped on the success-looking usage instead of self-correcting
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err: unknown) => {
    console.error(`memory-cli: ${(err as Error).message}`);
    process.exit(1);
  });
}
