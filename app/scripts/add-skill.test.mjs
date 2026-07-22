// Tests for add-skill's pure, security-relevant cores: the grants.mjs SKILL_NAMES
// append (surgery on a security file, so it's unit-pinned) and the owner/repo@slug
// parse. The npx/fs orchestration in main() is verified by a live `make add-skill`
// run before use, not here. Importing add-skill.mjs is side-effect-free (its
// main() is guarded by the argv[1]/import.meta.url check).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addSkillToGrants, parseSkillSpec, copyTree } from "./add-skill.mjs";

const GRANTS = join(dirname(fileURLToPath(import.meta.url)), "grants.mjs");
const SAMPLE = `import { x } from "y";
export const SKILL_NAMES = ["a", "b", "c"];
export const OTHER = 1;
`;

test("addSkillToGrants appends to SKILL_NAMES and leaves the rest untouched", () => {
  const out = addSkillToGrants(SAMPLE, "new-skill");
  assert.match(out, /export const SKILL_NAMES = \["a", "b", "c", "new-skill"\];/);
  assert.match(out, /import \{ x \} from "y";/); // preamble intact
  assert.match(out, /export const OTHER = 1;/);  // trailer intact
});

test("addSkillToGrants is idempotent (a name already present -> unchanged)", () => {
  assert.equal(addSkillToGrants(SAMPLE, "b"), SAMPLE);
});

test("addSkillToGrants tolerates a trailing comma/whitespace in the array", () => {
  const src = `export const SKILL_NAMES = ["a", "b", ];\n`;
  assert.match(addSkillToGrants(src, "z"), /\["a", "b", "z"\];/); // no double comma
});

test("addSkillToGrants on an EMPTY array yields [\"name\"] (no sparse hole)", () => {
  const src = `export const SKILL_NAMES = [];\n`;
  assert.match(addSkillToGrants(src, "solo"), /export const SKILL_NAMES = \["solo"\];/);
});

test("addSkillToGrants rejects an invalid name (charset / traversal / flag-shaped)", () => {
  for (const bad of ["Bad Name", "../x", "-flag", ".", "a/b", "UPPER"]) {
    assert.throws(() => addSkillToGrants(SAMPLE, bad), /invalid skill name/, `should reject ${JSON.stringify(bad)}`);
  }
});

test("addSkillToGrants throws when the array can't be found", () => {
  assert.throws(() => addSkillToGrants("const NOPE = 1;", "foo"), /SKILL_NAMES/);
});

test("addSkillToGrants works on the REAL grants.mjs (name lands at the end of the base list)", () => {
  const src = readFileSync(GRANTS, "utf8");
  const out = addSkillToGrants(src, "my-new-skill");
  // lands at the END of the array, whatever precedes it -- NOT anchored to a specific
  // current last entry (which would break the first time add-skill is used for real).
  assert.match(out, /, "my-new-skill"\];/);
  // idempotent against the real file too
  assert.equal(addSkillToGrants(out, "my-new-skill"), out);
});

test("copyTree recursively copies files + nested dirs (the SKILL.md + resources/ shape)", () => {
  const base = mkdtempSync(join(tmpdir(), "copytree-"));
  try {
    const src = join(base, "src");
    mkdirSync(join(src, "resources"), { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "# skill\nbody\n");
    writeFileSync(join(src, "resources", "deploy.sh"), "#!/bin/sh\necho hi\n");
    const dest = join(base, "dest");
    copyTree(src, dest);
    assert.equal(readFileSync(join(dest, "SKILL.md"), "utf8"), "# skill\nbody\n");
    assert.equal(readFileSync(join(dest, "resources", "deploy.sh"), "utf8"), "#!/bin/sh\necho hi\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("copyTree REFUSES a symlink in the fetched skill (secrets can't be baked as trusted content)", () => {
  const base = mkdtempSync(join(tmpdir(), "copytree-sym-"));
  try {
    const src = join(base, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "# ok\n");
    symlinkSync("/etc/passwd", join(src, "evil")); // a symlink pointing outside the skill
    assert.throws(() => copyTree(src, join(base, "dest")), /refusing to bake a symlink/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("copyTree REFUSES a symlinked ROOT dir (not just symlink entries)", () => {
  const base = mkdtempSync(join(tmpdir(), "copytree-root-"));
  try {
    const real = join(base, "real");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "SKILL.md"), "# x\n");
    const link = join(base, "link");
    symlinkSync(real, link); // the skill "dir" is itself a symlink
    assert.throws(() => copyTree(link, join(base, "dest")), /refusing to bake a symlink/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("parseSkillSpec splits owner/repo@slug and requires the @slug", () => {
  assert.deepEqual(parseSkillSpec("vercel-labs/agent-skills@deploy-to-vercel"), { repo: "vercel-labs/agent-skills", slug: "deploy-to-vercel" });
  assert.throws(() => parseSkillSpec("vercel-labs/agent-skills"), /owner\/repo@slug/); // no slug
  assert.throws(() => parseSkillSpec("noslash@x"), /owner\/repo/);
  assert.throws(() => parseSkillSpec("owner/repo@Bad Slug"), /slug/);
  assert.throws(() => parseSkillSpec("owner/repo@"), /owner\/repo@slug/);
});
