#!/usr/bin/env node
// Cross-cutting project notes -- Baxter's boundary CLI for a handful of
// markdown files he can carry across the email and Discord surfaces. It's the
// deliberately-small analog of files-cli: one .md per project under
// PROJECTS_DIR (inside the shared MEMORY_DIR), reachable only through
// `Bash(projects-cli *)`, and it can NEVER escape that directory. No secret
// lives here (the gmail/discord tokens are in the PARENT ~/.mail-agent, outside
// MEMORY_DIR); no deps; no shell.
//
// Four verbs, kept intentionally distinct:
//   make <name>   create projects/<slug>.md (errors if it already exists)
//   list          every project: slug, title, size, last-modified
//   open <slug>   print the full file to stdout (read it into context)
//   save <slug>   replace the WHOLE file from stdin, atomically (must exist)
//
// `save` is a whole-file overwrite (full contents on stdin), not a partial
// edit: all-or-nothing, and the temp-file+rename means a concurrent `open`
// never catches a half-written file. Accepted residual: two surfaces saving the
// SAME project at the same instant is last-write-wins (a lost update, not
// corruption) -- the same stance as the shared memory.md, and rare for a single
// operator.
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { PROJECTS_DIR } from "./paths.mjs";

// A saved project is notes, not a data lake -- cap it so a runaway save can't
// balloon the config volume. Generous for markdown (~1 MB of text).
const MAX_PROJECT_BYTES = 1024 * 1024;
const MAX_SLUG_LEN = 64;

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
  return { slug, path };
}

// Every project, sorted by slug: { slug, title, size, mtime }.
export function listProjects(root) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const slug = e.name.slice(0, -3);
    const path = join(root, e.name);
    let size = 0, mtime = null;
    try { const st = statSync(path); size = st.size; mtime = st.mtime; } catch { /* raced away */ }
    out.push({ slug, title: titleOf(path, slug), size, mtime });
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
  const projects = listProjects(root);
  if (projects.length === 0) return "(none yet)";
  const lines = projects.slice(0, PREAMBLE_MAX).map((p) => {
    const when = p.mtime ? p.mtime.toISOString().slice(0, 10) : "?";
    return `- ${p.slug} (updated ${when})`;
  });
  if (projects.length > PREAMBLE_MAX) {
    lines.push(`- …and ${projects.length - PREAMBLE_MAX} more (run \`projects-cli list\`)`);
  }
  return lines.join("\n");
}

// Full contents of a project, for reading back into context. Throws if it
// doesn't exist (pointing at list/make) rather than returning "".
export function openProject(root, name) {
  const { slug, path } = projectPath(root, name);
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`no project "${slug}" -- \`projects-cli list\` to see them, or \`projects-cli make <name>\` to start one`);
    }
    throw err;
  }
}

// Replace a project's WHOLE file with `contents`, atomically. The project must
// already exist (make it first) -- so a mistyped slug on save errors instead of
// silently spawning a stray project. Writes to a temp sibling then renames over
// the target, so a concurrent reader never sees a partial file.
export function saveProject(root, name, contents) {
  const { slug, path } = projectPath(root, name);
  const body = String(contents ?? "");
  if (Buffer.byteLength(body, "utf8") > MAX_PROJECT_BYTES) {
    throw new Error(`project contents exceed the ${Math.round(MAX_PROJECT_BYTES / 1024)} KB cap`);
  }
  // Must exist: statSync throws ENOENT -> translate to the make-first message.
  try {
    statSync(path);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`no project "${slug}" to save -- create it first with \`projects-cli make ${slug}\``);
    }
    throw err;
  }
  // Temp name carries the pid so two processes writing different projects can't
  // collide on the temp file; the rename onto `path` is the atomic swap.
  const tmp = join(root, `.${basename(slug)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort: leave no orphan temp behind (files-cli list would surface it
    // to the model as mystery state) whether the write OR the rename failed;
    // re-throw the underlying error regardless.
    try { unlinkSync(tmp); } catch { /* never created / already gone */ }
    throw err;
  }
  return { slug, path, bytes: Buffer.byteLength(body, "utf8") };
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
  "  projects-cli list                 list your projects (slug, title, size, modified)",
  "  projects-cli make <name>          start a new project (LIST FIRST to avoid a dupe)",
  "  projects-cli open <slug>          print a project's full contents",
  "  … | projects-cli save <slug>      replace a project's WHOLE contents from stdin",
  "",
  "One markdown file per project, shared across your email and Discord runs -- use",
  "it to carry context that spans threads/channels. `save` overwrites the entire",
  "file with what you pipe in (read it with `open` first, edit, then save it back).",
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
    const { slug } = makeProject(PROJECTS_DIR, name);
    console.log(`Created project "${slug}". Pipe its contents to \`projects-cli save ${slug}\` to fill it in.`);
  } else if (cmd === "open") {
    if (rest.length !== 1) throw new Error("usage: projects-cli open <slug>");
    process.stdout.write(openProject(PROJECTS_DIR, rest[0]));
  } else if (cmd === "save") {
    if (rest.length !== 1) throw new Error("usage: projects-cli save <slug>   (full contents on stdin)");
    const contents = await readStdin();
    const { slug, bytes } = saveProject(PROJECTS_DIR, rest[0], contents);
    console.log(`Saved project "${slug}" (${formatBytes(bytes)}).`);
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
