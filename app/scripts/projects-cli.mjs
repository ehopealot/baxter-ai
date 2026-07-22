#!/usr/bin/env node
// Cross-cutting project notes -- Baxter's boundary CLI for a handful of
// markdown files he can carry across the email and Discord surfaces. It's the
// deliberately-small analog of files-cli: one .md per project under
// PROJECTS_DIR (inside the shared MEMORY_DIR), reachable only through
// `Bash(projects-cli *)`, and it can NEVER escape that directory. No secret
// lives here (the gmail/discord tokens are in the PARENT ~/.mail-agent, outside
// MEMORY_DIR); one dep (proper-lockfile, shared with schedule-store, for the
// save concurrency guard below); no shell.
//
// Four verbs, kept intentionally distinct:
//   make <name>              create projects/<slug>.md (errors if it exists); vends a version
//   list                     every project: slug, title, size, last-modified
//   open <slug>              print the full file to stdout; vends its version on stderr
//   save <slug> --expect V   replace the WHOLE file from stdin, atomically, iff version==V
//
// `save` is a whole-file overwrite (full contents on stdin), not a partial edit:
// all-or-nothing, and the temp-file+rename means a concurrent `open` never
// catches a half-written file. Concurrent saves of the SAME project are guarded
// by optimistic concurrency (compare-and-swap): open/make/save vend an 8-hex
// `version:` token, and `save --expect <version>` is REJECTED if the file changed
// since that version -- so a save built on a stale read can't silently clobber a
// concurrent save (it's told to re-open and reapply). See versionToken/saveProject
// and docs/superpowers/specs/2026-07-22-projects-cli-cas-design.md.
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { PROJECTS_DIR } from "./paths.mjs";

// A saved project is notes, not a data lake -- cap it so a runaway save can't
// balloon the config volume. Generous for markdown (~1 MB of text).
const MAX_PROJECT_BYTES = 1024 * 1024;
const MAX_SLUG_LEN = 64;

// Optimistic-concurrency version token: the first 8 hex of sha256 over the file's
// RAW bytes. `open`/`make`/`save` vend it; `save --expect` requires it and rejects
// on mismatch -- so a save built on a stale read is caught loudly instead of
// silently clobbering a concurrent save (see the CAS design doc). Hashing the raw
// Buffer (never a decoded-then-re-encoded string) keeps the token identical on both
// the read and write sides, so an odd byte can't cause a permanent spurious-reject
// livelock. 8 hex = 32 bits: the compare is always two versions of the SAME file
// (a 2-way collision, ~2^-32 per conflicting save), and the model carries 8 chars
// verbatim with ease.
export function versionToken(buf) {
  return createHash("sha256").update(buf).digest("hex").slice(0, 8);
}
const VERSION_RE = /^[0-9a-f]{8}$/;

// Fold any human name (or an already-made slug) to a canonical slug:
// lowercase, non-alphanumerics collapse to single hyphens, trimmed, length
// capped. Idempotent -- slugify(slug) === slug -- so `open`/`save` accept
// either the slug `list` prints or the original name. Throws if nothing
// alphanumeric survives (an all-punctuation name has no usable file name).
export function slugify(name) {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, ""); // the slice can leave a trailing hyphen
  if (!slug) {
    throw new Error(`"${name}" has no letters or numbers to make a project name from`);
  }
  return slug;
}

// Absolute path of a project's file, confined to PROJECTS_DIR. slugify already
// strips every path-significant character (`/`, `.`, `..` all collapse away),
// so there's no traversal to reach; basename() is a defensive second belt in
// case slugify ever changes.
export function projectPath(root, name) {
  const slug = slugify(name);
  return { slug, path: join(root, `${basename(slug)}.md`) };
}

// First `# ` heading in the file, for the list view; falls back to the slug
// when there's no title line. Reads only what's needed cheaply -- the whole
// file, but files here are capped small.
function titleOf(path, slug) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return slug; }
  const m = text.match(/^#[ \t]+(.+?)[ \t]*$/m);
  return m ? m[1] : slug;
}

// Create projects/<slug>.md seeded with a title + created line. Errors if a
// project with that slug already exists (so a re-`make` can't clobber notes,
// and two different names that slugify the same collide loudly). `wx` makes the
// existence check and the create one atomic operation -- no check-then-write
// race.
export function makeProject(root, name) {
  const { slug, path } = projectPath(root, name);
  mkdirSync(root, { recursive: true });
  const seed = `# ${name}\n\n_Project created ${new Date().toISOString().slice(0, 10)}._\n`;
  try {
    writeFileSync(path, seed, { flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new Error(`project "${slug}" already exists -- open it with \`projects-cli open ${slug}\``);
    }
    throw err;
  }
  // Vend the seed's version so the first `save` after a `make` has a token without
  // a separate `open`. Hash the exact bytes just written (seed as UTF-8).
  return { slug, path, version: versionToken(Buffer.from(seed, "utf8")) };
}

// Every project, sorted by slug: { slug, title, size, mtime }. `withTitles:
// false` skips the per-file read `titleOf` needs (the preamble path only wants
// slug + mtime, and this runs on every render in the daemons' event loops) --
// title then falls back to the slug.
export function listProjects(root, { withTitles = true } = {}) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    // `.md` files only -- excludes proper-lockfile's `<slug>.md.lock` dirs (they
    // aren't files and don't end in `.md`) so a transient lock never leaks here.
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const slug = e.name.slice(0, -3);
    const path = join(root, e.name);
    let size = 0, mtime = null;
    try { const st = statSync(path); size = st.size; mtime = st.mtime; } catch { /* raced away */ }
    out.push({ slug, title: withTitles ? titleOf(path, slug) : slug, size, mtime });
  }
  out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return out;
}

// A compact snapshot of existing projects for a run's PREAMBLE (injected into
// every prompt so a run sees what exists without a tool call). Deliberately
// slug + last-updated date ONLY -- both are injection-safe by construction
// (slugs are `[a-z0-9-]`-confined, the date is numeric), so nothing here can
// smuggle a prompt-injection payload into the preamble across every future run.
// A project's free-text title/body is NOT included: that content can be
// indirectly attacker-influenced, and a run reads it deliberately via `open`,
// never has the daemon inject it verbatim. Capped so a large project set can't
// bloat every prompt.
const PREAMBLE_MAX = 40;
export function projectsPreamble(root = PROJECTS_DIR) {
  const projects = listProjects(root, { withTitles: false }); // slug + mtime only, no file reads
  if (projects.length === 0) return "(none yet)";
  // Order by recency (newest first) always, so active projects lead the list --
  // and, past the cap, so the most-recently-updated 40 are the ones kept rather
  // than the alphabetical head (listProjects sorts by slug). A null mtime sorts
  // last (dropped first); V8's stable sort breaks ties in that slug order.
  const byRecent = [...projects].sort((a, b) => (b.mtime?.getTime() ?? 0) - (a.mtime?.getTime() ?? 0));
  const lines = byRecent.slice(0, PREAMBLE_MAX).map((p) => {
    const when = p.mtime ? p.mtime.toISOString().slice(0, 10) : "?";
    return `- ${p.slug} (updated ${when})`;
  });
  if (projects.length > PREAMBLE_MAX) {
    lines.push(`- …and ${projects.length - PREAMBLE_MAX} more (run \`projects-cli list\`)`);
  }
  return lines.join("\n");
}

// Read a project ONCE, returning both the raw-byte Buffer and its version token.
// The CLI's `open` prints `buf` verbatim and vends `version` -- from the SAME read,
// deliberately: hashing a re-read would vend a newer version attached to the older
// body if a save landed between the two reads (a lost update with CAS "working").
// Throws a clear error if the project doesn't exist.
export function readProject(root, name) {
  const { slug, path } = projectPath(root, name);
  let buf;
  try {
    buf = readFileSync(path); // Buffer (raw bytes), not a utf8 string
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`no project "${slug}" -- \`projects-cli list\` to see them, or \`projects-cli make <name>\` to start one`);
    }
    throw err;
  }
  return { slug, path, buf, version: versionToken(buf) };
}

// Full contents of a project as a string, for reading back into context. Thin
// wrapper over readProject (one read); throws if it doesn't exist.
export function openProject(root, name) {
  return readProject(root, name).buf.toString("utf8");
}

// Replace a project's WHOLE file with `contents`, atomically, guarded by an
// optimistic-concurrency check: `expected` MUST equal the current file's version
// token (from a prior open/make/save), or the save is rejected -- so a save built
// on a stale read can't silently clobber a concurrent save. A brief proper-lockfile
// lock covers the read->compare->write->rename critical section: without it, two
// racing saves both holding the (then-)current token would both pass the compare
// and the second would overwrite the first. Returns the NEW version token so a
// second save in the same run needs no re-open. Async (the lock is async).
export async function saveProject(root, name, contents, expected) {
  const { slug, path } = projectPath(root, name);
  const bodyBuf = Buffer.from(String(contents ?? ""), "utf8");
  if (bodyBuf.length > MAX_PROJECT_BYTES) {
    throw new Error(`project contents exceed the ${Math.round(MAX_PROJECT_BYTES / 1024)} KB cap`);
  }
  // Existence check BEFORE the lock. projects-cli has no delete verb, so a project
  // that exists here can't vanish before we lock (no check-then-lock race), and it
  // lets us lock a path proper-lockfile knows exists. ENOENT -> make-first.
  try {
    statSync(path);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`no project "${slug}" to save -- create it first with \`projects-cli make ${slug}\``);
    }
    throw err;
  }
  // Token presence + format depend only on the caller's argument, so validate
  // them BEFORE taking the lock -- a missing/garbage token shouldn't contend for
  // the lock (masking the real usage error behind a "lock already held" after
  // retries) or read the whole file just to report a bad flag.
  const supplied = String(expected ?? "").trim().toLowerCase();
  if (!supplied) {
    throw new Error(`save requires the current --expect <version>: run \`projects-cli open ${slug}\` (or reuse the version from your last make/save), then save with it`);
  }
  if (!VERSION_RE.test(supplied)) {
    throw new Error(`--expect must be an 8-character hex version (got ${JSON.stringify(String(expected))}) -- it's the \`version:\` printed by open/make/save`);
  }
  const release = await lockfile.lock(path, {
    realpath: false, stale: 10000,
    retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
  });
  try {
    // Read the CURRENT bytes inside the lock -- this is the token basis, and it
    // must reflect any prior lock-holder's committed rename. Only the COMPARE
    // needs the lock (the format checks above are argument-only).
    const currentBuf = readFileSync(path);
    if (supplied !== versionToken(currentBuf)) {
      // Deliberately NEVER echo the current token: handing back the valid token
      // would let a lazy/steered run replay its STALE body and pass the check --
      // a one-step bypass of the whole mechanism. Echo only the supplied token.
      throw new Error(`project "${slug}" changed since you read it (your version ${supplied} is stale) -- re-open it, reapply your edit, and save with the new version`);
    }
    // Temp name carries the pid so two processes writing different projects can't
    // collide on the temp file; the rename onto `path` is the atomic swap.
    const tmp = join(root, `.${basename(slug)}.${process.pid}.tmp`);
    try {
      writeFileSync(tmp, bodyBuf);
      renameSync(tmp, path);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* never created / already gone */ }
      throw err;
    }
    // Vend the NEW token (of the exact bytes written) so a follow-up save this run
    // doesn't have to re-open.
    return { slug, path, bytes: bodyBuf.length, version: versionToken(bodyBuf) };
  } finally {
    await release();
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const USAGE = [
  "usage:",
  "  projects-cli list                        list your projects (slug, title, size, modified)",
  "  projects-cli make <name>                 start a new project (LIST FIRST to avoid a dupe)",
  "  projects-cli open <slug>                 print a project's full contents (+ its version)",
  "  … | projects-cli save <slug> --expect V  replace a project's WHOLE contents from stdin",
  "",
  "One markdown file per project, shared across your email and Discord runs -- use",
  "it to carry context that spans threads/channels. `save` overwrites the entire",
  "file with what you pipe in: `open` it first (or reuse the version from your last",
  "make/save), edit, then `save <slug> --expect <version>`. If it changed under you",
  "since that version, the save is rejected -- re-open, reapply, and save again.",
].join("\n");

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "list") {
    if (rest.length) throw new Error("usage: projects-cli list");
    const projects = listProjects(PROJECTS_DIR);
    if (projects.length === 0) {
      console.log("(no projects yet -- `projects-cli make <name>` to start one)");
      return;
    }
    for (const p of projects) {
      const when = p.mtime ? p.mtime.toISOString().slice(0, 10) : "?";
      console.log(`${p.slug}  —  ${p.title}  (${formatBytes(p.size)}, updated ${when})`);
    }
    console.log(`\n${projects.length} project(s)`);
  } else if (cmd === "make") {
    if (rest.length === 0) throw new Error("usage: projects-cli make <name>");
    const name = rest.join(" ");
    const { slug, version } = makeProject(PROJECTS_DIR, name);
    process.stderr.write(`version: ${version}\n`);
    console.log(`Created project "${slug}". Fill it in with \`… | projects-cli save ${slug} --expect ${version}\`.`);
  } else if (cmd === "open") {
    if (rest.length !== 1) throw new Error("usage: projects-cli open <slug>");
    const { buf, version } = readProject(PROJECTS_DIR, rest[0]);
    // stderr FIRST, so a head-truncated tool result never drops the token; the
    // `version:` line is CLI metadata, never part of the file body on stdout.
    process.stderr.write(`version: ${version}\n`);
    process.stdout.write(buf);
  } else if (cmd === "save") {
    // save <slug> --expect <8hex>   (full contents on stdin). Order-tolerant flag.
    let slug = null, expected;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--expect") { expected = rest[++i]; }
      else if (slug === null) { slug = rest[i]; }
      else throw new Error("usage: projects-cli save <slug> --expect <version>   (full contents on stdin)");
    }
    if (!slug) throw new Error("usage: projects-cli save <slug> --expect <version>   (full contents on stdin)");
    const contents = await readStdin();
    const { slug: saved, bytes, version } = await saveProject(PROJECTS_DIR, slug, contents, expected);
    process.stderr.write(`version: ${version}\n`);
    console.log(`Saved project "${saved}" (${formatBytes(bytes)}). New version: ${version}.`);
  } else {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0); // no command = help (0); bad command = error (1)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(`projects-cli: ${err.message}`);
    process.exit(1);
  });
}
