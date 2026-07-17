// Unit tests for the OpenRouter runner's security-critical, SDK-independent core:
// the CLI allowlist derived from allowedTools, cwd confinement, and the tool
// executors. Run with `node --test`. No @openrouter/agent, no API key needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tokenizeAllowedTools, parseAllowedTools, resolveInCwd,
  runCli, readFile, writeFile, editFile, loadSkill,
} from "./openrouter-tools.mjs";

const NODE = process.execPath;

test("tokenizeAllowedTools keeps Bash(...) groups intact despite inner spaces", () => {
  const toks = tokenizeAllowedTools("Bash(node /x/gmail.mjs *) Bash(discord-cli *) WebSearch Read");
  assert.deepEqual(toks, ["Bash(node /x/gmail.mjs *)", "Bash(discord-cli *)", "WebSearch", "Read"]);
});

test("parseAllowedTools builds the CLI allowlist + native set from a real allowedTools string", () => {
  const { cliMap, native } = parseAllowedTools(
    "Bash(node /app/scripts/gmail.mjs *) Bash(discord-cli *) Bash(code-cli *) WebSearch WebFetch Skill Read Write Edit",
  );
  assert.deepEqual(cliMap["discord-cli"], { command: "discord-cli", prefixArgs: [] });
  assert.deepEqual(cliMap["code-cli"], { command: "code-cli", prefixArgs: [] });
  // gmail granted as `node <path>` -> friendly name "gmail" -> node + path prefix
  assert.deepEqual(cliMap["gmail"], { command: "node", prefixArgs: ["/app/scripts/gmail.mjs"] });
  assert.ok(native.has("Read") && native.has("Write") && native.has("Edit") && native.has("Skill"));
  assert.ok(native.has("WebSearch") && native.has("WebFetch"));
});

test("parseAllowedTools takes only prefix grants (trailing *) and first-wins on a name collision", () => {
  const { cliMap } = parseAllowedTools("Bash(discord-cli *) Bash(git status) Bash(discord-cli --evil *)");
  assert.deepEqual(cliMap["discord-cli"], { command: "discord-cli", prefixArgs: [] }); // first grant kept, not overwritten
  assert.equal("git" in cliMap, false); // exact grant (no trailing *) is not a runnable CLI here
});

test("resolveInCwd allows in-tree paths and refuses escapes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orcwd-"));
  assert.equal(resolveInCwd(cwd, "memory.md"), join(cwd, "memory.md"));
  assert.equal(resolveInCwd(cwd, "a/b.md"), join(cwd, "a", "b.md"));
  assert.throws(() => resolveInCwd(cwd, "../secret"), /escapes the working directory/);
  assert.throws(() => resolveInCwd(cwd, "/etc/passwd"), /escapes the working directory/);
});

test("runCli refuses a cli that isn't in the allowlist", async () => {
  const r = await runCli({ cli: "rm", args: ["-rf", "/"] }, { cliMap: { "discord-cli": { command: "discord-cli", prefixArgs: [] } } });
  assert.equal(r.ok, false);
  assert.match(r.error, /not allowed/);
});

test("runCli cleanly refuses a prototype-key cli name (constructor/hasOwnProperty)", async () => {
  const { cliMap } = parseAllowedTools("Bash(discord-cli *)");
  const r = await runCli({ cli: "constructor" }, { cliMap });
  assert.equal(r.ok, false);
  assert.match(r.error, /not allowed/);
});

test("runCli runs an allowed cli with prefixArgs + args and captures stdout/exit", async () => {
  const cliMap = { echo: { command: NODE, prefixArgs: ["-e", "process.stdout.write(process.argv.slice(1).join(','))"] } };
  const r = await runCli({ cli: "echo", args: ["a", "b"] }, { cliMap, maxBytes: 1 << 20, timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "a,b");
});

test("runCli feeds stdin and surfaces a nonzero exit without throwing", async () => {
  const cliMap = {
    catn: { command: NODE, prefixArgs: ["-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(s);process.exit(3)})"] },
  };
  const r = await runCli({ cli: "catn", stdin: "hello" }, { cliMap, maxBytes: 1 << 20, timeoutMs: 5000 });
  assert.equal(r.ok, false);      // exit 3
  assert.equal(r.exitCode, 3);
  assert.equal(r.stdout, "hello"); // stdin echoed back
});

test("runCli flags truncation when output exceeds the byte cap (even in one chunk)", async () => {
  const cliMap = { big: { command: NODE, prefixArgs: ["-e", "process.stdout.write('x'.repeat(1000))"] } };
  const r = await runCli({ cli: "big" }, { cliMap, maxBytes: 100, timeoutMs: 5000 });
  assert.equal(r.stdout.length, 100);
  assert.equal(r.truncated, true);
});

test("editFile writes $-patterns in new_string literally (no replacement-special expansion)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "oredit-"));
  const ctx = { cwd };
  writeFile({ path: "f.txt", content: "PRICE here" }, ctx);
  assert.equal(editFile({ path: "f.txt", old_string: "PRICE", new_string: "costs $$40 and $& stays" }, ctx).ok, true);
  assert.equal(readFileSync(join(cwd, "f.txt"), "utf8"), "costs $$40 and $& stays here");
});

test("read/write/edit round-trip within cwd, and reject an escape", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orfs-"));
  const ctx = { cwd };
  assert.equal(writeFile({ path: "note.md", content: "one two" }, ctx).ok, true);
  assert.equal(readFile({ path: "note.md" }, ctx).content, "one two");
  assert.equal(editFile({ path: "note.md", old_string: "two", new_string: "three" }, ctx).ok, true);
  assert.equal(readFileSync(join(cwd, "note.md"), "utf8"), "one three");
  // escape refused
  const esc = readFile({ path: "../../etc/passwd" }, ctx);
  assert.equal(esc.ok, false);
  assert.match(esc.error, /escapes the working directory/);
  // edit with a non-unique old_string is refused
  writeFile({ path: "dup.md", content: "x x" }, ctx);
  assert.match(editFile({ path: "dup.md", old_string: "x", new_string: "y" }, ctx).error, /not unique/);
});

test("writes into .claude/ are refused (no self-authored trusted skill), reads stay allowed", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orclaude-"));
  mkdirSync(join(cwd, ".claude", "skills", "discord"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "skills", "discord", "SKILL.md"), "# real");
  const ctx = { cwd };
  // write/edit into .claude/ are refused -- a run must not author a skill it can
  // then load in the same run (bypassing the BAKED_SKILL_NAMES shadow guard).
  const w = writeFile({ path: ".claude/skills/discord/SKILL.md", content: "# poisoned" }, ctx);
  assert.equal(w.ok, false);
  assert.match(w.error, /\.claude\/ is read-only/);
  assert.equal(readFileSync(join(cwd, ".claude", "skills", "discord", "SKILL.md"), "utf8"), "# real"); // untouched
  assert.equal(editFile({ path: ".claude/skills/discord/SKILL.md", old_string: "real", new_string: "poison" }, ctx).ok, false);
  // reads of .claude/ still work (load_skill / read_file)
  assert.equal(loadSkill({ name: "discord" }, ctx).content, "# real");
  assert.equal(readFile({ path: ".claude/skills/discord/SKILL.md" }, ctx).content, "# real");
  // a normal write elsewhere in cwd still works (the guard is .claude/-specific)
  assert.equal(writeFile({ path: "memory.md", content: "ok" }, ctx).ok, true);
});

test("loadSkill reads a staged SKILL.md and can't be traversed out of the skills dir", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orskill-"));
  mkdirSync(join(cwd, ".claude", "skills", "discord"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "skills", "discord", "SKILL.md"), "# discord skill");
  assert.equal(loadSkill({ name: "discord" }, { cwd }).content, "# discord skill");
  // a traversal name is basename-stripped, so it resolves inside skills/ (and just misses)
  assert.equal(loadSkill({ name: "../../../etc/passwd" }, { cwd }).ok, false);
});
