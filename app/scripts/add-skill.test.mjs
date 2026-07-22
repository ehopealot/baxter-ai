// Tests for add-skill's pure, security-relevant cores: the grants.mjs SKILL_NAMES
// append (surgery on a security file, so it's unit-pinned) and the owner/repo@slug
// parse. The npx/fs orchestration in main() is verified by a live `make add-skill`
// run before use, not here. Importing add-skill.mjs is side-effect-free (its
// main() is guarded by the argv[1]/import.meta.url check).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addSkillToGrants, parseSkillSpec } from "./add-skill.mjs";

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
  // appended after the last current entry, still one array literal
  assert.match(out, /"skill-discovery", "my-new-skill"\];/);
  // idempotent against the real file too
  assert.equal(addSkillToGrants(out, "my-new-skill"), out);
});

test("parseSkillSpec splits owner/repo@slug and requires the @slug", () => {
  assert.deepEqual(parseSkillSpec("vercel-labs/agent-skills@deploy-to-vercel"), { repo: "vercel-labs/agent-skills", slug: "deploy-to-vercel" });
  assert.throws(() => parseSkillSpec("vercel-labs/agent-skills"), /owner\/repo@slug/); // no slug
  assert.throws(() => parseSkillSpec("noslash@x"), /owner\/repo/);
  assert.throws(() => parseSkillSpec("owner/repo@Bad Slug"), /slug/);
  assert.throws(() => parseSkillSpec("owner/repo@"), /owner\/repo@slug/);
});
