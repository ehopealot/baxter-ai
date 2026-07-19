// Focused tests for projects-cli.mjs's exported functions. Imports are safe:
// projects-cli.mjs guards its CLI dispatch behind the import.meta.url/argv[1]
// check, so importing these doesn't run the CLI. Each test builds a throwaway
// projects dir so nothing touches the real workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugify, projectPath, makeProject, listProjects, openProject, saveProject, projectsPreamble } from "./projects-cli.mjs";

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), "projects-cli-"));
  return join(tmp, "projects"); // not created yet -- make() creates it lazily
}

test("slugify folds names to a canonical, idempotent slug", () => {
  assert.equal(slugify("Q3 Launch!"), "q3-launch");
  assert.equal(slugify("  Multiple   Spaces  "), "multiple-spaces");
  assert.equal(slugify("q3-launch"), "q3-launch"); // idempotent
  assert.equal(slugify("Café — Déjà"), "caf-d-j"); // non-ascii dropped, collapsed
});

test("slugify rejects an all-punctuation name", () => {
  assert.throws(() => slugify("!!!"), /no letters or numbers/);
  assert.throws(() => slugify(""), /no letters or numbers/);
});

test("slugify caps length and never leaves a trailing hyphen", () => {
  const slug = slugify("a".repeat(80));
  assert.equal(slug.length, 64);
  assert.ok(!slug.endsWith("-"));
  // A name whose 64th char lands on a separator must not keep the hyphen.
  const trimmed = slugify("x".repeat(63) + " tail");
  assert.ok(!trimmed.endsWith("-"));
});

test("projectPath stays inside the root and can't traverse", () => {
  const root = "/base/projects";
  assert.equal(projectPath(root, "notes").path, join(root, "notes.md"));
  // Traversal characters collapse away in the slug -- the file lands in root.
  assert.equal(projectPath(root, "../../etc/passwd").path, join(root, "etc-passwd.md"));
});

test("make creates a seeded file and refuses a duplicate slug", () => {
  const root = fixture();
  const { slug, path } = makeProject(root, "Q3 Launch");
  assert.equal(slug, "q3-launch");
  const text = readFileSync(path, "utf8");
  assert.match(text, /^# Q3 Launch$/m);
  assert.match(text, /Project created \d{4}-\d{2}-\d{2}/);
  // A different name that slugifies the same collides loudly (no clobber).
  assert.throws(() => makeProject(root, "q3 launch"), /already exists/);
});

test("list reports slug, title from the first heading, sorted", () => {
  const root = fixture();
  makeProject(root, "Zebra");
  makeProject(root, "Apple");
  saveProject(root, "apple", "# Apple Project\n\nbody\n"); // title from the # heading
  saveProject(root, "zebra", "no heading here\n");         // no heading -> fallback branch
  const projects = listProjects(root);
  assert.deepEqual(projects.map((p) => p.slug), ["apple", "zebra"]);
  assert.equal(projects[0].title, "Apple Project"); // pulled from the heading
  assert.equal(projects[1].title, "zebra");         // actually falls back to the slug
});

test("list title survives CRLF line endings (no trailing \\r captured)", () => {
  // save writes stdin verbatim -- no line-ending normalization -- and
  // model-produced CRLF content is a documented real occurrence in this repo.
  // A carriage return must NOT leak into the printed title (it would garble the
  // terminal line). `.` doesn't match \r and multiline `$` matches before it,
  // so the heading regex trims it; pin that here.
  const root = fixture();
  makeProject(root, "Winter");
  saveProject(root, "winter", "# Winter Plan\r\n\r\nbody\r\n");
  const [p] = listProjects(root);
  assert.equal(p.title, "Winter Plan");
  assert.ok(!p.title.includes("\r"));
});

test("list returns [] for a nonexistent dir and ignores non-.md files", () => {
  const root = fixture();
  assert.deepEqual(listProjects(root), []);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "stray.txt"), "nope");
  writeFileSync(join(root, ".hidden.tmp"), "nope");
  assert.deepEqual(listProjects(root), []);
});

test("open returns full contents and errors clearly when missing", () => {
  const root = fixture();
  makeProject(root, "Notes");
  saveProject(root, "notes", "# Notes\n\nline one\nline two\n");
  assert.equal(openProject(root, "notes"), "# Notes\n\nline one\nline two\n");
  // Accepts the original name too (slugified to the same file).
  assert.equal(openProject(root, "Notes"), "# Notes\n\nline one\nline two\n");
  assert.throws(() => openProject(root, "ghost"), /no project "ghost"/);
});

test("save requires the project to exist first (no upsert)", () => {
  const root = fixture();
  assert.throws(() => saveProject(root, "unmade", "x"), /create it first/);
});

test("save replaces the whole file and enforces the size cap", () => {
  const root = fixture();
  makeProject(root, "Doc");
  saveProject(root, "doc", "first\n");
  saveProject(root, "doc", "totally new\n");
  assert.equal(openProject(root, "doc"), "totally new\n"); // whole-file overwrite
  const huge = "a".repeat(1024 * 1024 + 1);
  assert.throws(() => saveProject(root, "doc", huge), /cap/);
});

test("projectsPreamble renders (none yet) when empty", () => {
  const root = fixture();
  assert.equal(projectsPreamble(root), "(none yet)");
});

test("projectsPreamble lists slug + date, and only injection-safe chars", () => {
  const root = fixture();
  makeProject(root, "Q3 Launch!");   // title has punctuation; slug must be clean
  makeProject(root, "Apple");
  const out = projectsPreamble(root);
  assert.match(out, /^- apple \(updated \d{4}-\d{2}-\d{2}\)$/m);
  assert.match(out, /^- q3-launch \(updated \d{4}-\d{2}-\d{2}\)$/m);
  // No newlines-in-value, no `{{`, no `---` separator, no raw title punctuation:
  // slugs are [a-z0-9-] and dates are numeric, so the block can't carry a
  // prompt-injection payload into the preamble.
  assert.ok(!/\{\{|^-{3,}$|!/m.test(out));
});

test("projectsPreamble caps the list, keeping the most-recently-updated", () => {
  const root = fixture();
  // p00 oldest ... p44 newest (1 minute apart) -- so recency selection keeps
  // p05..p44 and drops the 5 oldest (p00..p04). Alphabetical selection would do
  // the opposite (keep p00..p39), so this discriminates the two.
  for (let i = 0; i < 45; i++) {
    const { path } = makeProject(root, `p${String(i).padStart(2, "0")}`);
    const t = new Date(Date.UTC(2026, 0, 1) + i * 60_000);
    utimesSync(path, t, t);
  }
  const out = projectsPreamble(root);
  const listed = out.split("\n").filter((l) => l.startsWith("- p")).length;
  assert.equal(listed, 40);
  assert.match(out, /…and 5 more \(run `projects-cli list`\)/);
  assert.ok(out.includes("- p44 "), "newest kept");
  assert.ok(!out.includes("- p00 "), "oldest dropped (recency, not alphabetical)");
});

test("save leaves no temp file behind on success", () => {
  const root = fixture();
  makeProject(root, "Clean");
  saveProject(root, "clean", "content\n");
  const leftovers = readdirSync(root).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});
