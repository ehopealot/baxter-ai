#!/usr/bin/env node
// `make add-skill SKILL=owner/repo@slug [NAME=<name>]` -- the operator-side "bake"
// step for a skill from the open ecosystem. (Discovery is Baxter's job via
// skills-cli find + the skill-discovery skill; INSTALLING is deliberately yours.)
// It fetches the skill with the ecosystem's own `npx skills add` into an ISOLATED
// temp dir, copies the vetted dir into app/skills/<name>/, and appends <name> to
// grants.mjs's one shared SKILL_NAMES so every surface stages it.
//
// The vetting gate is preserved: add-skill only stages WORKING-TREE changes.
// Baxter doesn't get the skill until you review `git diff` (the new SKILL.md + any
// resources + the grants edit), commit, and `make deploy`. Nothing goes live behind
// your back, even though the fetch is automated -- and the skill runs with full
// agent permissions once baked, so the review matters.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ -> app/
const SKILLS_DIR = join(APP_DIR, "skills");
const GRANTS_PATH = join(APP_DIR, "scripts", "grants.mjs");
// A skill dir name / slug: alphanumeric first char (no leading '-'/dot, no
// flag-shaped '--x'), then [a-z0-9-], <=64. Same shape files-cli/projects-cli use.
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The ONE matcher for grants.mjs's base skill-name array -- both the membership
// check and the append parse it through this, so they can't drift.
const SKILL_NAMES_RE = /(export const SKILL_NAMES = \[)([\s\S]*?)(\];)/;

// True iff `name` is already in grants.mjs's SKILL_NAMES. Exported + reused by both
// addSkillToGrants (idempotence) and main (shadow-guard) so there's one owner of the
// parse. Returns false (not throw) when the array is absent -- addSkillToGrants
// gives the "can't find the array" error in that case.
export function hasSkill(source, name) {
  const m = source.match(SKILL_NAMES_RE);
  return !!m && new RegExp(`["']${name}["']`).test(m[2]);
}

// Append `name` to grants.mjs's `export const SKILL_NAMES = [ ... ]`. Pure +
// exported for tests. Idempotent (a name already present -> source unchanged).
// Throws on an invalid name or if the array can't be found. Only ever touches that
// one array literal -- the per-surface *_SKILL_SRCS derive their subsets by
// filtering, so a name added here flows to every surface (each minus its exclusions).
export function addSkillToGrants(source, name) {
  if (!NAME_RE.test(name)) throw new Error(`invalid skill name "${name}" (need [a-z0-9-], <=64, alphanumeric first char)`);
  const m = source.match(SKILL_NAMES_RE);
  if (!m) throw new Error("could not find `export const SKILL_NAMES = [ ... ];` in grants.mjs");
  if (hasSkill(source, name)) return source; // already present -> no-op
  const inner = m[2].replace(/[\s,]*$/, ""); // drop any trailing comma/whitespace
  // `inner ? … : ""` so an EMPTY array yields ["name"], not a sparse ["", "name"] hole.
  const replaced = `${m[1]}${inner ? `${inner}, ` : ""}"${name}"${m[3]}`;
  return source.slice(0, m.index) + replaced + source.slice(m.index + m[0].length);
}

// Parse owner/repo@slug -> { repo: "owner/repo", slug }. The @slug is REQUIRED so we
// install exactly one skill; a bare owner/repo would pull the whole repo.
export function parseSkillSpec(spec) {
  const s = String(spec || "").trim();
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) throw new Error(`SKILL must be owner/repo@slug (got ${JSON.stringify(spec)})`);
  const repo = s.slice(0, at);
  const slug = s.slice(at + 1);
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repo)) throw new Error(`SKILL repo must be owner/repo (got ${JSON.stringify(repo)})`);
  if (!NAME_RE.test(slug)) throw new Error(`SKILL slug must be [a-z0-9-] (got ${JSON.stringify(slug)})`);
  return { repo, slug };
}

// Recursive copy via read/write, NOT fs.cpSync: cpSync's native binding EACCESes on
// some overlay/bind-mount filesystems (e.g. a Docker-mounted repo) where plain
// mkdir/read/write succeed. Skills are small (SKILL.md + a few resources), so a
// userspace copy is fine. Regular files + dirs only; a **symlink is REJECTED** (not
// followed) -- a fetched skill is attacker-influenced, and a symlink (even SKILL.md
// itself) pointing at e.g. ~/.mail-agent/data-keys.json would otherwise materialize
// secret content as trusted, auto-staged skill text. A baked skill has no symlinks.
// Exported for tests.
export function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isSymbolicLink()) throw new Error(`refusing to bake a symlink in the fetched skill: ${e.name} (skills must be plain files)`);
    else if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) writeFileSync(d, readFileSync(s));
    else throw new Error(`refusing to bake a non-regular file in the fetched skill: ${e.name}`);
  }
}

function main() {
  const { repo, slug } = parseSkillSpec(process.argv[2]);
  const name = (process.argv[3] || "").trim() || slug;
  if (!NAME_RE.test(name)) throw new Error(`NAME must be [a-z0-9-], <=64, alphanumeric first char (got ${JSON.stringify(name)})`);

  // Shadow-guard: never overwrite an existing baked skill (vetting would be lost)
  // and never clash a name already in the list -- the same floor ensureSkills enforces.
  const dest = join(SKILLS_DIR, name);
  if (existsSync(dest)) throw new Error(`app/skills/${name} already exists -- pick a different NAME (this won't overwrite a baked skill)`);
  let grants = readFileSync(GRANTS_PATH, "utf8");
  if (hasSkill(grants, name)) throw new Error(`"${name}" is already a baked skill in grants.mjs -- pick a different NAME`);

  // Fetch with the ecosystem's own tool into an ISOLATED temp dir (never the repo),
  // copy mode so we get real files (not symlinks into agent dirs).
  const staging = mkdtempSync(join(tmpdir(), "add-skill-"));
  try {
    console.error(`Fetching ${repo}@${slug} via npx skills (staging in ${staging}) ...`);
    execFileSync("npx", ["--yes", "skills@latest", "add", repo, "-s", slug, "--copy", "-y"], { cwd: staging, stdio: "inherit" });
    const src = join(staging, ".claude", "skills", slug);
    if (!existsSync(join(src, "SKILL.md"))) {
      throw new Error(`no SKILL.md at ${src} after fetch -- did slug "${slug}" match a skill in ${repo}? (try: npx skills add ${repo} -l)`);
    }
    copyTree(src, dest);
    console.error(`Copied the skill -> app/skills/${name}/`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  // Wire grants.mjs (append to the one shared list), then run the grants tests so a
  // bad edit fails HERE, not at the next daemon start.
  writeFileSync(GRANTS_PATH, addSkillToGrants(grants, name));
  console.error(`Appended "${name}" to grants.mjs SKILL_NAMES.`);
  execFileSync("node", ["--test", join(APP_DIR, "scripts", "grants.test.mjs")], { cwd: APP_DIR, stdio: "inherit" });

  console.error([
    ``,
    `Baked skill "${name}" from ${repo}@${slug}.`,
    `It runs with FULL agent permissions once deployed.`,
    `NEXT: review app/skills/${name}/ (SKILL.md + any resources) and \`git diff\`,`,
    `      then commit and \`make deploy\`. Nothing is live until you rebuild --`,
    `      add-skill only staged working-tree changes.`,
  ].join("\n"));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (e) {
    console.error(`add-skill: ${e.message}`);
    process.exit(1);
  }
}
