// Focused tests for projects-cli.mjs's exported functions. Imports are safe:
// projects-cli.mjs guards its CLI dispatch behind the import.meta.url/argv[1]
// check, so importing these doesn't run the CLI. Each test builds a throwaway
// projects dir so nothing touches the real workspace.
//
// CAS note: saveProject is async (a brief proper-lockfile lock wraps the
// verify+rename) and REQUIRES an --expect token = versionToken of the bytes the
// caller read. make/read/save all vend that token, so the setup helper `seed`
// threads it for tests that only need content in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugify, projectPath, makeProject, listProjects, openProject, readProject, saveProject, versionToken, projectsPreamble } from "./projects-cli.mjs";

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), "projects-cli-"));
  return join(tmp, "projects"); // not created yet -- make() creates it lazily
}

// make + save `body`, threading the version token; returns the saved version.
async function seed(root, name, body) {
  const { slug, version } = makeProject(root, name);
  const r = await saveProject(root, slug, body, version);
  return { slug, version: r.version };
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
  const trimmed = slugify("x".repeat(63) + " tail");
  assert.ok(!trimmed.endsWith("-"));
});

test("projectPath stays inside the root and can't traverse", () => {
  const root = "/base/projects";
  assert.equal(projectPath(root, "notes").path, join(root, "notes.md"));
  assert.equal(projectPath(root, "../../etc/passwd").path, join(root, "etc-passwd.md"));
});

// --- CAS: versionToken ---

test("versionToken is the first 8 hex of sha256 over RAW bytes (deterministic, known value)", () => {
  // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  assert.equal(versionToken(Buffer.from("hello")), "2cf24dba");
  assert.match(versionToken(Buffer.from("anything")), /^[0-9a-f]{8}$/);
  // Raw bytes, no UTF-8 round-trip: a value written as a string then read back as
  // a Buffer hashes identically (this is what stops the spurious-reject livelock).
  const root = fixture();
  mkdirSync(root, { recursive: true });
  const body = "# t\n\nbödy with non-ascii ☕\n";
  writeFileSync(join(root, "x.md"), body);
  const readback = readFileSync(join(root, "x.md")); // Buffer
  assert.equal(versionToken(readback), versionToken(Buffer.from(body, "utf8")));
});

test("make creates a seeded file, vends its version, and refuses a duplicate slug", () => {
  const root = fixture();
  const { slug, path, version } = makeProject(root, "Q3 Launch");
  assert.equal(slug, "q3-launch");
  const bytes = readFileSync(path);
  assert.match(bytes.toString("utf8"), /^# Q3 Launch$/m);
  assert.equal(version, versionToken(bytes)); // make vends the seed's token
  assert.throws(() => makeProject(root, "q3 launch"), /already exists/);
});

test("read returns body + version from ONE read (version matches the printed buffer)", async () => {
  const root = fixture();
  await seed(root, "Notes2", "# Notes2\n\nline\n");
  const r = readProject(root, "notes2");
  assert.ok(Buffer.isBuffer(r.buf));
  assert.equal(r.buf.toString("utf8"), "# Notes2\n\nline\n");
  assert.equal(r.version, versionToken(r.buf)); // token is of the exact buffer returned
  assert.throws(() => readProject(root, "ghost"), /no project "ghost"/);
});

test("list reports slug, title from the first heading, sorted", async () => {
  const root = fixture();
  await seed(root, "Zebra", "no heading here\n");
  await seed(root, "Apple", "# Apple Project\n\nbody\n");
  const projects = listProjects(root);
  assert.deepEqual(projects.map((p) => p.slug), ["apple", "zebra"]);
  assert.equal(projects[0].title, "Apple Project");
  assert.equal(projects[1].title, "zebra"); // falls back to slug
});

test("list title survives CRLF line endings (no trailing \\r captured)", async () => {
  const root = fixture();
  await seed(root, "Winter", "# Winter Plan\r\n\r\nbody\r\n");
  const [p] = listProjects(root);
  assert.equal(p.title, "Winter Plan");
  assert.ok(!p.title.includes("\r"));
});

test("list returns [] for a nonexistent dir and ignores non-.md files (and .lock artifacts)", () => {
  const root = fixture();
  assert.deepEqual(listProjects(root), []);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "stray.txt"), "nope");
  writeFileSync(join(root, ".hidden.tmp"), "nope");
  mkdirSync(join(root, "real.md.lock")); // proper-lockfile artifact must not leak
  assert.deepEqual(listProjects(root), []);
});

test("open returns full contents and errors clearly when missing", async () => {
  const root = fixture();
  await seed(root, "Notes", "# Notes\n\nline one\nline two\n");
  assert.equal(openProject(root, "notes"), "# Notes\n\nline one\nline two\n");
  assert.equal(openProject(root, "Notes"), "# Notes\n\nline one\nline two\n"); // original name too
  assert.throws(() => openProject(root, "ghost"), /no project "ghost"/);
});

// --- CAS: saveProject ---

test("save requires the project to exist first (existence checked before the token)", async () => {
  const root = fixture();
  await assert.rejects(saveProject(root, "unmade", "x", "00000000"), /create it first/);
});

test("save requires an --expect token (mandatory, enforces open-before-write)", async () => {
  const root = fixture();
  const { version } = makeProject(root, "Doc");
  // a valid save works with the token...
  await saveProject(root, "doc", "first\n", version);
  // ...but omitting the token is refused (points the run at open)
  await assert.rejects(saveProject(root, "doc", "second\n", undefined), /--expect|open .*first|version/i);
});

test("save rejects a malformed token (not 8 hex) with a clear message", async () => {
  const root = fixture();
  const { version } = makeProject(root, "Doc");
  await saveProject(root, "doc", "first\n", version);
  await assert.rejects(saveProject(root, "doc", "x\n", "zzzz"), /8[- ]?char|hex|version/i);
});

test("save with the matching token writes and vends the NEW token", async () => {
  const root = fixture();
  const { version: v0 } = makeProject(root, "Doc");
  const r1 = await saveProject(root, "doc", "totally new\n", v0);
  assert.equal(openProject(root, "doc"), "totally new\n");
  assert.equal(r1.version, versionToken(Buffer.from("totally new\n", "utf8")));
  // The vended token lets a SECOND save in the same run proceed with no re-open.
  const r2 = await saveProject(root, "doc", "again\n", r1.version);
  assert.equal(openProject(root, "doc"), "again\n");
  assert.equal(r2.version, versionToken(Buffer.from("again\n", "utf8")));
});

test("save enforces the size cap", async () => {
  const root = fixture();
  const { version } = makeProject(root, "Doc");
  const huge = "a".repeat(1024 * 1024 + 1);
  await assert.rejects(saveProject(root, "doc", huge, version), /cap/);
});

test("CAS: a stale token is rejected (file unchanged, current token NOT leaked); the fresh token succeeds", async () => {
  const root = fixture();
  const mk = makeProject(root, "Ledger");
  const { version: v1 } = { version: (await saveProject(root, "ledger", "v1 body\n", mk.version)).version };
  // Another run's save lands out of band -> v2.
  const v2body = "v2 body from another run\n";
  writeFileSync(join(root, "ledger.md"), v2body);
  const currentToken = versionToken(Buffer.from(v2body, "utf8"));
  // A save built on the stale v1 read is rejected, the file is untouched, and the
  // error must NOT hand back the current token (that would let a stale body pass).
  await assert.rejects(
    saveProject(root, "ledger", "my edit on stale v1\n", v1),
    (err) => {
      assert.match(err.message, /changed since you read it/i);
      assert.ok(!err.message.includes(currentToken), "reject leaked the current token");
      return true;
    },
  );
  assert.equal(openProject(root, "ledger"), v2body); // rejected save changed nothing
  // Re-open for the fresh token, reapply, save -> succeeds.
  const fresh = readProject(root, "ledger");
  await saveProject(root, "ledger", "reconciled on v2\n", fresh.version);
  assert.equal(openProject(root, "ledger"), "reconciled on v2\n");
});

test("save leaves no temp file behind on success (and releases its lock)", async () => {
  const root = fixture();
  const { version } = makeProject(root, "Clean");
  await saveProject(root, "clean", "content\n", version);
  const leftovers = readdirSync(root).filter((f) => f.includes(".tmp") || f.endsWith(".lock"));
  assert.deepEqual(leftovers, []);
});

// --- preamble (unchanged behavior) ---

test("projectsPreamble renders (none yet) when empty", () => {
  const root = fixture();
  assert.equal(projectsPreamble(root), "(none yet)");
});

test("projectsPreamble lists slug + date, and only injection-safe chars", () => {
  const root = fixture();
  makeProject(root, "Q3 Launch!");
  makeProject(root, "Apple");
  const out = projectsPreamble(root);
  assert.match(out, /^- apple \(updated \d{4}-\d{2}-\d{2}\)$/m);
  assert.match(out, /^- q3-launch \(updated \d{4}-\d{2}-\d{2}\)$/m);
  assert.ok(!/\{\{|^-{3,}$|!/m.test(out));
});

test("projectsPreamble caps the list, keeping the most-recently-updated", () => {
  const root = fixture();
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
