#!/usr/bin/env node
// Cross-cutting collection notes -- Baxter's boundary CLI for a handful of
// Markdown files he can carry across every surface. It's the
// deliberately-small analog of files-cli: one .md per collection under
// COLLECTIONS_DIR (inside the shared MEMORY_DIR), reachable only through
// `Bash(collections-cli *)`, and it can NEVER escape that directory. No secret
// lives here (the mail/discord key files are in the PARENT ~/.mail-agent, outside
// MEMORY_DIR); one dep (proper-lockfile, shared with schedule-store, for the
// save concurrency guard below); no shell.
//
// Four verbs, kept intentionally distinct:
//   make <name>              create collections/<slug>.md (errors if it exists); vends a version
//   list                     every collection: slug, title, size, last-modified
//   open <slug>              print the full file to stdout; vends its version on stderr
//   save <slug> --expect V   replace the WHOLE file from stdin, atomically, iff version==V
//
// `save` is a whole-file overwrite (full contents on stdin), not a partial edit:
// all-or-nothing, and the temp-file+rename means a concurrent `open` never
// catches a half-written file. Concurrent saves of the SAME collection are guarded
// by optimistic concurrency (compare-and-swap): open/make/save vend an 8-hex
// `version:` token, and `save --expect <version>` is REJECTED if the file changed
// since that version -- so a save built on a stale read can't silently clobber a
// concurrent save (it's told to re-open and reapply). See versionToken/saveCollection
// and docs/superpowers/specs/2026-07-22-projects-cli-cas-design.md.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { COLLECTIONS_DIR } from "./paths.ts";
// The CAS core (version token + locked, atomic, compare-and-swap write) is shared
// with memory-cli -- see cas-file.ts. Re-exported so existing importers of
// `versionToken` from this module keep working.
import { versionToken, normalizeExpected, casSave } from "./cas-file.ts";
export { versionToken };

// A saved collection is notes, not a data lake -- cap it so a runaway save can't
// balloon the config volume. Generous for markdown (~1 MB of text).
export const MAX_COLLECTION_BYTES = 1024 * 1024;
const MAX_SLUG_LEN = 64;

// Fold any human name (or an already-made slug) to a canonical slug:
// lowercase, non-alphanumerics collapse to single hyphens, trimmed, length
// capped. Idempotent -- slugify(slug) === slug -- so `open`/`save` accept
// either the slug `list` prints or the original name. Throws if nothing
// alphanumeric survives (an all-punctuation name has no usable file name).
export function slugify(name: unknown): string {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, ""); // the slice can leave a trailing hyphen
  if (!slug) {
    throw new Error(`"${name}" has no letters or numbers to make a collection name from`);
  }
  return slug;
}

// A canonical slug is already exactly the spelling slugify would produce.
// Discovery/publication use this predicate rather than normalizing filenames.
export function isCanonicalSlug(slug: string): boolean {
  if (!slug || slug.length > MAX_SLUG_LEN) return false;
  try {
    return slugify(slug) === slug;
  } catch {
    return false;
  }
}

// Absolute path of a collection's file, confined to COLLECTIONS_DIR. slugify already
// strips every path-significant character (`/`, `.`, `..` all collapse away),
// so there's no traversal to reach; basename() is a defensive second belt in
// case slugify ever changes.
export function collectionPath(root: string, name: unknown): { slug: string; path: string } {
  const slug = slugify(name);
  return { slug, path: join(root, `${basename(slug)}.md`) };
}

// First `# ` heading in the file, for the list view; falls back to the slug
// when there's no title line. Reads only what's needed cheaply -- the whole
// file, but files here are capped small.
function titleOf(path: string, slug: string): string {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return slug; }
  const m = text.match(/^#[ \t]+(.+?)[ \t]*$/m);
  return m ? m[1] : slug;
}

// Create collections/<slug>.md seeded with a title + agent-only created comment. Errors if a
// collection with that slug already exists (so a re-`make` can't clobber notes,
// and two different names that slugify the same collide loudly). `wx` makes the
// existence check and the create one atomic operation -- no check-then-write
// race.
export function makeCollection(root: string, name: unknown): { slug: string; path: string; version: string } {
  const { slug, path } = collectionPath(root, name);
  mkdirSync(root, { recursive: true });
  const seed = `# ${name}\n\n<comment>\n_Collection created ${new Date().toISOString().slice(0, 10)}._\n</comment>\n`;
  try {
    writeFileSync(path, seed, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`collection "${slug}" already exists -- open it with \`collections-cli open ${slug}\``);
    }
    throw err;
  }
  // Vend the seed's version so the first `save` after a `make` has a token without
  // a separate `open`. Hash the exact bytes just written (seed as UTF-8).
  return { slug, path, version: versionToken(Buffer.from(seed, "utf8")) };
}

// Every collection, sorted by slug: { slug, title, size, mtime }. `withTitles:
// false` skips the per-file read `titleOf` needs (the preamble path only wants
// slug + mtime, and this runs on every render in the daemons' event loops) --
// title then falls back to the slug.
export interface CollectionListing {
  slug: string;
  title: string;
  size: number;
  mtime: Date | null;
}

export function listCollections(root: string, { withTitles = true }: { withTitles?: boolean } = {}): CollectionListing[] {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out: CollectionListing[] = [];
  for (const e of entries) {
    // `.md` files only -- excludes proper-lockfile's `<slug>.md.lock` dirs (they
    // aren't files and don't end in `.md`) so a transient lock never leaks here.
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const slug = e.name.slice(0, -3);
    const path = join(root, e.name);
    let size = 0, mtime: Date | null = null;
    try { const st = statSync(path); size = st.size; mtime = st.mtime; } catch { /* raced away */ }
    out.push({ slug, title: withTitles ? titleOf(path, slug) : slug, size, mtime });
  }
  out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return out;
}

// A compact snapshot of existing collections for a run's PREAMBLE (injected into
// every prompt so a run sees what exists without a tool call). Deliberately
// slug + last-updated date ONLY -- both are injection-safe by construction
// (slugs are `[a-z0-9-]`-confined, the date is numeric), so nothing here can
// smuggle a prompt-injection payload into the preamble across every future run.
// A collection's free-text title/body is NOT included: that content can be
// indirectly attacker-influenced, and a run reads it deliberately via `open`,
// never has the daemon inject it verbatim. Capped so a large collection set can't
// bloat every prompt.
const PREAMBLE_MAX = 40;
export function collectionsPreamble(root: string = COLLECTIONS_DIR): string {
  const collections = listCollections(root, { withTitles: false }); // slug + mtime only, no file reads
  if (collections.length === 0) return "(none yet)";
  // Order by recency (newest first) always, so active collections lead the list --
  // and, past the cap, so the most-recently-updated 40 are the ones kept rather
  // than the alphabetical head (listCollections sorts by slug). A null mtime sorts
  // last (dropped first); V8's stable sort breaks ties in that slug order.
  const byRecent = [...collections].sort((a, b) => (b.mtime?.getTime() ?? 0) - (a.mtime?.getTime() ?? 0));
  const lines = byRecent.slice(0, PREAMBLE_MAX).map((p) => {
    const when = p.mtime ? p.mtime.toISOString().slice(0, 10) : "?";
    return `- ${p.slug} (updated ${when})`;
  });
  if (collections.length > PREAMBLE_MAX) {
    lines.push(`- …and ${collections.length - PREAMBLE_MAX} more (run \`collections-cli list\`)`);
  }
  return lines.join("\n");
}

// Read a collection ONCE, returning both the raw-byte Buffer and its version token.
// The CLI's `open` prints `buf` verbatim and vends `version` -- from the SAME read,
// deliberately: hashing a re-read would vend a newer version attached to the older
// body if a save landed between the two reads (a lost update with CAS "working").
// Throws a clear error if the collection doesn't exist.
export function readCollection(root: string, name: unknown): { slug: string; path: string; buf: Buffer; version: string } {
  const { slug, path } = collectionPath(root, name);
  let buf: Buffer;
  try {
    buf = readFileSync(path); // Buffer (raw bytes), not a utf8 string
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no collection "${slug}" -- \`collections-cli list\` to see them, or \`collections-cli make <name>\` to start one`);
    }
    throw err;
  }
  return { slug, path, buf, version: versionToken(buf) };
}

// Full contents of a collection as a string, for reading back into context. Thin
// wrapper over readCollection (one read); throws if it doesn't exist.
export function openCollection(root: string, name: unknown): string {
  return readCollection(root, name).buf.toString("utf8");
}

// Replace a collection's WHOLE file with `contents`, atomically, guarded by an
// optimistic-concurrency check: `expected` MUST equal the current file's version
// token (from a prior open/make/save), or the save is rejected -- so a save built
// on a stale read can't silently clobber a concurrent save. A brief proper-lockfile
// lock covers the read->compare->write->rename critical section: without it, two
// racing saves both holding the (then-)current token would both pass the compare
// and the second would overwrite the first. Returns the NEW version token so a
// second save in the same run needs no re-open. Async (the lock is async).
export async function saveCollection(root: string, name: unknown, contents: unknown, expected: unknown): Promise<{ slug: string; path: string; bytes: number; version: string }> {
  const { slug, path } = collectionPath(root, name);
  const bodyBuf = Buffer.from(String(contents ?? ""), "utf8");
  if (bodyBuf.length > MAX_COLLECTION_BYTES) {
    throw new Error(`collection contents exceed the ${Math.round(MAX_COLLECTION_BYTES / 1024)} KB cap`);
  }
  // Existence check BEFORE the lock. collections-cli has no delete verb, so a collection
  // that exists here can't vanish before we lock (no check-then-lock race), and it
  // lets us lock a path proper-lockfile knows exists. ENOENT -> make-first.
  try {
    statSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no collection "${slug}" to save -- create it first with \`collections-cli make ${slug}\``);
    }
    throw err;
  }
  // Token presence + format depend only on the caller's argument, so validate them
  // BEFORE taking the lock (a missing/garbage token shouldn't contend for the lock).
  const supplied = normalizeExpected(expected, `run \`collections-cli open ${slug}\` (or reuse the version from your last make/save), then save with it`);
  // The locked read->compare->atomic-write core is shared with memory-cli.
  const { bytes, version } = await casSave(path, bodyBuf, supplied, `collection "${slug}"`, "re-open it, reapply your edit, and save with the new version");
  return { slug, path, bytes, version };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const USAGE = [
  "usage:",
  "  collections-cli list                        list your collections (slug, title, size, modified)",
  "  collections-cli make <name>                 start a new collection (LIST FIRST to avoid a dupe)",
  "  collections-cli open <slug>                 print a collection's full contents (+ its version)",
  "  … | collections-cli save <slug> --expect V  replace a collection's WHOLE contents from stdin",
  "",
  "Treat each collection title as a category; organize user data as Markdown lists",
  "of objects, items, or related facts. Put Baxter-only thoughts in exact",
  "<comment>...</comment> blocks (Home omits them). `save` overwrites the entire",
  "file with what you pipe in: `open` it first (or reuse the version from your last",
  "make/save), edit, then `save <slug> --expect <version>`. If it changed under you",
  "since that version, the save is rejected -- re-open, reapply, and save again.",
].join("\n");

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "list") {
    if (rest.length) throw new Error("usage: collections-cli list");
    const collections = listCollections(COLLECTIONS_DIR);
    if (collections.length === 0) {
      console.log("(no collections yet -- `collections-cli make <name>` to start one)");
      return;
    }
    for (const p of collections) {
      const when = p.mtime ? p.mtime.toISOString().slice(0, 10) : "?";
      console.log(`${p.slug}  —  ${p.title}  (${formatBytes(p.size)}, updated ${when})`);
    }
    console.log(`\n${collections.length} collection(s)`);
  } else if (cmd === "make") {
    if (rest.length === 0) throw new Error("usage: collections-cli make <name>");
    const name = rest.join(" ");
    const { slug, version } = makeCollection(COLLECTIONS_DIR, name);
    process.stderr.write(`version: ${version}\n`);
    console.log(`Created collection "${slug}". Fill it in with \`… | collections-cli save ${slug} --expect ${version}\`.`);
  } else if (cmd === "open") {
    if (rest.length !== 1) throw new Error("usage: collections-cli open <slug>");
    const { buf, version } = readCollection(COLLECTIONS_DIR, rest[0]);
    // stderr FIRST, so a head-truncated tool result never drops the token; the
    // `version:` line is CLI metadata, never part of the file body on stdout.
    process.stderr.write(`version: ${version}\n`);
    process.stdout.write(buf);
  } else if (cmd === "save") {
    // save <slug> --expect <8hex>   (full contents on stdin). Order-tolerant flag.
    let slug: string | null = null, expected: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--expect") { expected = rest[++i]; }
      else if (slug === null) { slug = rest[i]; }
      else throw new Error("usage: collections-cli save <slug> --expect <version>   (full contents on stdin)");
    }
    if (!slug) throw new Error("usage: collections-cli save <slug> --expect <version>   (full contents on stdin)");
    const contents = await readStdin();
    const { slug: saved, bytes, version } = await saveCollection(COLLECTIONS_DIR, slug, contents, expected);
    process.stderr.write(`version: ${version}\n`);
    console.log(`Saved collection "${saved}" (${formatBytes(bytes)}). New version: ${version}.`);
  } else {
    console.error(USAGE);
    process.exit(cmd ? 1 : 2); // nonzero even with NO subcommand: exit-0-with-usage made run_cli report ok:true, so a model that misinvoked (cmd in stdin, no args) looped on the success-looking usage instead of self-correcting
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err: unknown) => {
    console.error(`collections-cli: ${(err as Error).message}`);
    process.exit(1);
  });
}
