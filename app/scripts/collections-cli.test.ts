// Focused tests for collections-cli.ts's exported functions. Imports are safe:
// collections-cli.ts guards its CLI dispatch behind the import.meta.url/argv[1]
// check, so importing these doesn't run the CLI. Each test builds a throwaway
// collections dir so nothing touches the real workspace.
//
// CAS note: saveCollection is async (a brief proper-lockfile lock wraps the
// verify+rename) and REQUIRES an --expect token = versionToken of the bytes the
// caller read. make/read/save all vend that token, so the setup helper `seed`
// threads it for tests that only need content in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, utimesSync, rmSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLLECTIONS_DIR, MEMORY_DIR } from "./paths.ts";
import { slugify, collectionPath, makeCollection, listCollections, openCollection, readCollection, saveCollection, versionToken, collectionsPreamble } from "./collections-cli.ts";

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), "collections-cli-"));
  return join(tmp, "collections"); // not created yet -- make() creates it lazily
}

// make + save `body`, threading the version token; returns the saved version.
async function seed(root: string, name: string, body: string) {
  const { slug, version } = makeCollection(root, name);
  const r = await saveCollection(root, slug, body, version);
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

test("collectionPath stays inside the root and can't traverse", () => {
  const root = "/base/collections";
  assert.equal(collectionPath(root, "notes").path, join(root, "notes.md"));
  assert.equal(collectionPath(root, "../../etc/passwd").path, join(root, "etc-passwd.md"));
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
  const { slug, path, version } = makeCollection(root, "Q3 Launch");
  assert.equal(slug, "q3-launch");
  const bytes = readFileSync(path);
  assert.match(bytes.toString("utf8"), /^# Q3 Launch$/m);
  assert.equal(version, versionToken(bytes)); // make vends the seed's token
  assert.throws(() => makeCollection(root, "q3 launch"), /already exists/);
});

test("read returns body + version from ONE read (version matches the printed buffer)", async () => {
  const root = fixture();
  await seed(root, "Notes2", "# Notes2\n\nline\n");
  const r = readCollection(root, "notes2");
  assert.ok(Buffer.isBuffer(r.buf));
  assert.equal(r.buf.toString("utf8"), "# Notes2\n\nline\n");
  assert.equal(r.version, versionToken(r.buf)); // token is of the exact buffer returned
  assert.throws(() => readCollection(root, "ghost"), /no collection "ghost"/);
});

test("list reports slug, title from the first heading, sorted", async () => {
  const root = fixture();
  await seed(root, "Zebra", "no heading here\n");
  await seed(root, "Apple", "# Apple Collection\n\nbody\n");
  const collections = listCollections(root);
  assert.deepEqual(collections.map((p) => p.slug), ["apple", "zebra"]);
  assert.equal(collections[0].title, "Apple Collection");
  assert.equal(collections[1].title, "zebra"); // falls back to slug
});

test("list title survives CRLF line endings (no trailing \\r captured)", async () => {
  const root = fixture();
  await seed(root, "Winter", "# Winter Plan\r\n\r\nbody\r\n");
  const [p] = listCollections(root);
  assert.equal(p.title, "Winter Plan");
  assert.ok(!p.title.includes("\r"));
});

test("list returns [] for a nonexistent dir and ignores non-.md files (and .lock artifacts)", () => {
  const root = fixture();
  assert.deepEqual(listCollections(root), []);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "stray.txt"), "nope");
  writeFileSync(join(root, ".hidden.tmp"), "nope");
  mkdirSync(join(root, "real.md.lock")); // proper-lockfile artifact must not leak
  assert.deepEqual(listCollections(root), []);
});

test("open returns full contents and errors clearly when missing", async () => {
  const root = fixture();
  await seed(root, "Notes", "# Notes\n\nline one\nline two\n");
  assert.equal(openCollection(root, "notes"), "# Notes\n\nline one\nline two\n");
  assert.equal(openCollection(root, "Notes"), "# Notes\n\nline one\nline two\n"); // original name too
  assert.throws(() => openCollection(root, "ghost"), /no collection "ghost"/);
});

// --- CAS: saveCollection ---

test("save requires the collection to exist first (existence checked before the token)", async () => {
  const root = fixture();
  await assert.rejects(saveCollection(root, "unmade", "x", "00000000"), /create it first/);
});

test("save requires an --expect token (mandatory, enforces open-before-write)", async () => {
  const root = fixture();
  const { version } = makeCollection(root, "Doc");
  // a valid save works with the token...
  await saveCollection(root, "doc", "first\n", version);
  // ...but omitting the token is refused (points the run at open)
  await assert.rejects(saveCollection(root, "doc", "second\n", undefined), /--expect|open .*first|version/i);
});

test("save rejects a malformed token (not 8 hex) with a clear message", async () => {
  const root = fixture();
  const { version } = makeCollection(root, "Doc");
  await saveCollection(root, "doc", "first\n", version);
  await assert.rejects(saveCollection(root, "doc", "x\n", "zzzz"), /8[- ]?char|hex|version/i);
});

test("save with the matching token writes and vends the NEW token", async () => {
  const root = fixture();
  const { version: v0 } = makeCollection(root, "Doc");
  const r1 = await saveCollection(root, "doc", "totally new\n", v0);
  assert.equal(openCollection(root, "doc"), "totally new\n");
  assert.equal(r1.version, versionToken(Buffer.from("totally new\n", "utf8")));
  // The vended token lets a SECOND save in the same run proceed with no re-open.
  const r2 = await saveCollection(root, "doc", "again\n", r1.version);
  assert.equal(openCollection(root, "doc"), "again\n");
  assert.equal(r2.version, versionToken(Buffer.from("again\n", "utf8")));
});

test("save enforces the size cap", async () => {
  const root = fixture();
  const { version } = makeCollection(root, "Doc");
  const huge = "a".repeat(1024 * 1024 + 1);
  await assert.rejects(saveCollection(root, "doc", huge, version), /cap/);
});

test("CAS: a stale token is rejected (file unchanged, current token NOT leaked); the fresh token succeeds", async () => {
  const root = fixture();
  const mk = makeCollection(root, "Ledger");
  const { version: v1 } = { version: (await saveCollection(root, "ledger", "v1 body\n", mk.version)).version };
  // Another run's save lands out of band -> v2.
  const v2body = "v2 body from another run\n";
  writeFileSync(join(root, "ledger.md"), v2body);
  const currentToken = versionToken(Buffer.from(v2body, "utf8"));
  // A save built on the stale v1 read is rejected, the file is untouched, and the
  // error must NOT hand back the current token (that would let a stale body pass).
  await assert.rejects(
    saveCollection(root, "ledger", "my edit on stale v1\n", v1),
    (err: unknown) => {
      const e = err as Error;
      assert.match(e.message, /changed since you read it/i);
      assert.ok(!e.message.includes(currentToken), "reject leaked the current token");
      return true;
    },
  );
  assert.equal(openCollection(root, "ledger"), v2body); // rejected save changed nothing
  // Re-open for the fresh token, reapply, save -> succeeds.
  const fresh = readCollection(root, "ledger");
  await saveCollection(root, "ledger", "reconciled on v2\n", fresh.version);
  assert.equal(openCollection(root, "ledger"), "reconciled on v2\n");
});

// The lock is the load-bearing half of CAS, and pinning it needs a CROSS-PROCESS
// race (mirrors send-state.test.ts). An IN-process test can't: without the lock,
// saveCollection has no await point (all fs calls are sync), so an async function
// runs to completion before the next starts -- the second save always reads the
// post-rename bytes and rejects, passing lock-free. Only two real processes can
// both read v0 before either renames (the lost-update the lock prevents). Loop it:
// with the lock, EVERY round is one-win-one-reject (deterministic, not flaky); a
// missing lock lets some overlapping round land two successes (a silent clobber),
// which the assertion catches.
test("CAS lock serializes concurrent saves ACROSS PROCESSES (a removed lock would lose an update)", async () => {
  const home = mkdtempSync(join(tmpdir(), "collections-cli-race-"));
  const root = join(home, "collections");
  makeCollection(root, "Race"); // saveCollection takes root explicitly, so no HOME plumbing needed
  const modUrl = new URL("./collections-cli.ts", import.meta.url).href;
  // Child: save with a supplied token; exit 0 = won, 3 = CAS-rejected, 1 = other.
  const script = (body: string, expect: string) =>
    `import(${JSON.stringify(modUrl)})` +
    `.then((m) => m.saveCollection(${JSON.stringify(root)}, "race", ${JSON.stringify(body)}, ${JSON.stringify(expect)}))` +
    `.then(() => process.exit(0), (e) => process.exit(/changed since you read it/.test(String(e && e.message)) ? 3 : 1));`;
  // exit 0 = won, 3 = CAS-rejected, 1 = other (incl. a signal-kill/spawn error,
  // whose err.code is null/string -> route to "other", NOT the winner bucket, so a
  // crashed child can't masquerade as a second win and falsely accuse the lock).
  const child = (body: string, expect: string): Promise<number> =>
    new Promise((resolve) => execFile(process.execPath, ["-e", script(body, expect)], (err) => resolve(err ? (typeof err.code === "number" ? err.code : 1) : 0)));
  try {
    const ROUNDS = 12;
    for (let i = 0; i < ROUNDS; i++) {
      const base = readCollection(root, "race").version; // fresh base token each round
      const a = `A round ${i}\n`, b = `B round ${i}\n`; // bound once, reused in both places
      const codes = await Promise.all([child(a, base), child(b, base)]);
      const wins = codes.filter((c) => c === 0).length;
      const casRejects = codes.filter((c) => c === 3).length;
      assert.equal(wins, 1, `round ${i}: expected exactly ONE winner, got exit codes ${codes} (two wins = a lost update, i.e. a missing/broken lock)`);
      assert.equal(casRejects, 1, `round ${i}: expected exactly one CAS reject, got exit codes ${codes}`);
      // The file must be the SPECIFIC winner's whole body -- codes[0] is child A's
      // exit, so a 0 there means A won. Pinning to the winner (not "either body")
      // also catches a reject path that still wrote: that would leave the LOSER's
      // body on disk with the exit codes unchanged, which "either" would wave through.
      const winnerBody = codes[0] === 0 ? a : b;
      assert.equal(openCollection(root, "race"), winnerBody, `round ${i}: file must be the winner's whole body, not a merge or the rejected loser's write`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("save leaves no temp file behind on success (and releases its lock)", async () => {
  const root = fixture();
  const { version } = makeCollection(root, "Clean");
  await saveCollection(root, "clean", "content\n", version);
  const leftovers = readdirSync(root).filter((f) => f.includes(".tmp") || f.endsWith(".lock"));
  assert.deepEqual(leftovers, []);
});

// --- preamble (unchanged behavior) ---

test("collectionsPreamble renders (none yet) when empty", () => {
  const root = fixture();
  assert.equal(collectionsPreamble(root), "(none yet)");
});

test("collectionsPreamble lists slug + date, and only injection-safe chars", () => {
  const root = fixture();
  makeCollection(root, "Q3 Launch!");
  makeCollection(root, "Apple");
  const out = collectionsPreamble(root);
  assert.match(out, /^- apple \(updated \d{4}-\d{2}-\d{2}\)$/m);
  assert.match(out, /^- q3-launch \(updated \d{4}-\d{2}-\d{2}\)$/m);
  assert.ok(!/\{\{|^-{3,}$|!/m.test(out));
});

test("collectionsPreamble caps the list, keeping the most-recently-updated", () => {
  const root = fixture();
  for (let i = 0; i < 45; i++) {
    const { path } = makeCollection(root, `p${String(i).padStart(2, "0")}`);
    const t = new Date(Date.UTC(2026, 0, 1) + i * 60_000);
    utimesSync(path, t, t);
  }
  const out = collectionsPreamble(root);
  const listed = out.split("\n").filter((l) => l.startsWith("- p")).length;
  assert.equal(listed, 40);
  assert.match(out, /…and 5 more \(run `collections-cli list`\)/);
  assert.ok(out.includes("- p44 "), "newest kept");
  assert.ok(!out.includes("- p00 "), "oldest dropped (recency, not alphabetical)");
});

// --- the Collections hard-rename contract (2026-08-18) ---

test("COLLECTIONS_DIR is MEMORY_DIR/collections, and a sibling projects/ store is invisible to Collections", () => {
  // Pins the storage cutover: the durable store is MEMORY_DIR/collections, and the
  // old user-data MEMORY_DIR/projects directory -- which the operator renames during
  // downtime -- is never listed, opened, or written through the Collections code.
  assert.equal(COLLECTIONS_DIR, join(MEMORY_DIR, "collections"));
  const home = mkdtempSync(join(tmpdir(), "collections-cli-store-"));
  const memory = join(home, "memory-workspace");
  const collections = join(memory, "collections");
  const oldProjects = join(memory, "projects");
  mkdirSync(oldProjects, { recursive: true });
  writeFileSync(join(oldProjects, "legacy.md"), "# Legacy project note\n");
  // A populated sibling projects/ dir is neither listed nor openable via Collections,
  // and an absent collections/ dir stays lazily empty.
  assert.deepEqual(listCollections(collections), []);
  assert.throws(() => readCollection(collections, "legacy"), /no collection "legacy"/);
  assert.equal(collectionsPreamble(collections), "(none yet)");
  // Creating through Collections never touches the old store.
  makeCollection(collections, "Fresh Start");
  assert.ok(existsSync(join(collections, "fresh-start.md")));
  assert.ok(!existsSync(join(oldProjects, "fresh-start.md")), "Collections must not write into the old projects/ store");
  rmSync(home, { recursive: true, force: true });
});

// Run the real CLI in a subprocess with HOME pointed at a throwaway dir (homedir()
// drives every derived path, so this is hermetic -- the same trick the race test
// avoids needing by passing root explicitly). Pins that ALL user-facing copy --
// usage, make's direct-to-save guidance, seeded boilerplate, open's version line,
// and error guidance -- says Collection/collections-cli and never Projects/projects-cli.
test("CLI copy uses Collections terminology: usage, make guidance, boilerplate, version line, and errors", async () => {
  const home = mkdtempSync(join(tmpdir(), "collections-cli-copy-"));
  const script = join(import.meta.dirname, "collections-cli.ts");
  const run = (args: string[], stdin = "") =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const child = execFile(process.execPath, [script, ...args], { env: { ...process.env, HOME: home } }, (err, stdout, stderr) => {
        resolve({ code: err && typeof err.code === "number" ? err.code : 0, out: String(stdout), err: String(stderr) });
      });
      child.stdin!.end(stdin);
    });
  try {
    // No subcommand -> usage (exit 2), naming collections-cli.
    const usage = await run([]);
    assert.equal(usage.code, 2);
    assert.match(usage.err, /usage:[\s\S]*collections-cli list/);
    assert.ok(!/projects/i.test(usage.err + usage.out), "usage must not mention the retired Projects name");
    // make -> version on stderr + direct-to-save guidance naming collections-cli.
    const made = await run(["make", "Kitchen Reno"]);
    assert.equal(made.code, 0);
    assert.match(made.err, /^version: [0-9a-f]{8}\n$/);
    assert.match(made.out, /Created collection "kitchen-reno"\. Fill it in with `… \| collections-cli save kitchen-reno --expect [0-9a-f]{8}`\./);
    // Seeded boilerplate says Collection, not Project.
    const body = readFileSync(join(home, ".mail-agent", "memory-workspace", "collections", "kitchen-reno.md"), "utf8");
    assert.match(body, /^_Collection created \d{4}-\d{2}-\d{2}\._$/m);
    assert.ok(!/project/i.test(body), "seeded boilerplate must say Collection");
    // open -> the version line on stderr, body verbatim on stdout.
    const opened = await run(["open", "kitchen-reno"]);
    assert.equal(opened.code, 0);
    assert.match(opened.err, /^version: [0-9a-f]{8}\n$/);
    assert.equal(opened.out, body);
    // A malformed-token save's guidance names collections-cli (never the old CLI).
    const bad = await run(["save", "kitchen-reno", "--expect", "zzzz"], "replaced\n");
    assert.equal(bad.code, 1);
    assert.match(bad.err, /collections-cli: /);
    assert.ok(!/projects-cli/i.test(bad.err + bad.out), "error guidance must name collections-cli only");
    // A stale save (token of different bytes) also rejects with collections-cli copy.
    const stale = await run(["save", "kitchen-reno", "--expect", versionToken(Buffer.from("other\n", "utf8"))], "replaced\n");
    assert.equal(stale.code, 1);
    assert.match(stale.err, /collection "kitchen-reno" changed since you read it/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The image puts the CLI on PATH via a printf shim block (app/Dockerfile). Pins the rename
// at the container seam: the shim must write /usr/local/bin/collections-cli and exec the
// renamed module, and the retired shim path must not survive anywhere in the Dockerfile.
test("Dockerfile shim: /usr/local/bin/collections-cli execs collections-cli.ts, and no retired shim remains", () => {
  const dockerfile = readFileSync(join(import.meta.dirname, "..", "Dockerfile"), "utf8");
  assert.ok(dockerfile.includes("> /usr/local/bin/collections-cli"), "the shim block writes the PATH shim");
  assert.ok(dockerfile.includes('exec node /app/scripts/collections-cli.ts "$@"'), "the shim execs the renamed collections-cli.ts");
  assert.ok(!dockerfile.includes("/usr/local/bin/projects-cli"), "no shim for the retired CLI may remain anywhere in the Dockerfile");
});
