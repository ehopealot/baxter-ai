import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import {
  MAIL_TOOLS, DISCORD_TOOLS, HEARTBEAT_TOOLS,
  SKILL_SRCS, HEARTBEAT_SKILL_SRCS, SKILL_NAMES,
  BAKED_SKILL_NAMES,
} from "./grants.mjs";

// The tool strings are a security boundary; these lock in the deliberate
// per-surface asymmetries that used to live in three separate inline strings.
test("every surface grants the shared core tools", () => {
  for (const tools of [MAIL_TOOLS, DISCORD_TOOLS, HEARTBEAT_TOOLS]) {
    for (const t of ["Bash(code-cli *)", "Bash(files-cli *)", "Bash(projects-cli *)", "Bash(data-cli *)", "Bash(skills-cli *)", "Bash(web-cli *)", "Bash(playwright-cli *)", "Bash(invisible-cli *)", "WebSearch", "WebFetch", "Skill", "Read", "Write", "Edit"]) {
      assert.ok(tools.includes(t), `${t} missing from ${tools}`);
    }
  }
});

test("mail grants gmail + schedule-cli, never discord", () => {
  assert.match(MAIL_TOOLS, /Bash\(node \S*gmail\.mjs \*\)/);
  assert.ok(MAIL_TOOLS.includes("Bash(schedule-cli *)"));
  assert.ok(!MAIL_TOOLS.includes("discord-cli"), "mail must not grant discord");
});

test("discord grants discord + schedule-cli, never gmail", () => {
  assert.match(DISCORD_TOOLS, /Bash\(node \S*discord-cli\.mjs \*\)/);
  assert.ok(DISCORD_TOOLS.includes("Bash(discord-cli *)"));
  assert.ok(DISCORD_TOOLS.includes("Bash(schedule-cli *)"));
  assert.ok(!DISCORD_TOOLS.includes("gmail.mjs"), "discord must not grant gmail");
});

test("heartbeat grants gmail + discord but NOT schedule-cli (a fired task can't schedule)", () => {
  assert.match(HEARTBEAT_TOOLS, /Bash\(node \S*gmail\.mjs \*\)/);
  assert.match(HEARTBEAT_TOOLS, /Bash\(node \S*discord-cli\.mjs \*\)/);
  assert.ok(HEARTBEAT_TOOLS.includes("Bash(discord-cli *)"));
  assert.ok(!HEARTBEAT_TOOLS.includes("schedule-cli"), "a fired task must not schedule/cancel tasks");
});

test("skills are consolidated to one list; heartbeat is that list minus `schedule` (its sole exclusion)", () => {
  const shared = SKILL_SRCS.map((s) => basename(s));
  const hb = HEARTBEAT_SKILL_SRCS.map((s) => basename(s));
  assert.deepEqual(shared.slice().sort(), SKILL_NAMES.slice().sort()); // mail/discord/voice = the whole list
  // Heartbeat excludes EXACTLY `schedule` -- the one deliberate asymmetry, matching
  // its missing schedule-cli tool -- and nothing else.
  assert.ok(shared.includes("schedule"), "the shared list carries the schedule skill");
  assert.ok(!hb.includes("schedule"), "heartbeat must NOT stage the schedule skill (it has no schedule-cli tool)");
  assert.deepEqual(hb.slice().sort(), shared.filter((n) => n !== "schedule").sort());
  // everyday skills survived the consolidation on both
  for (const n of ["discord", "projects", "data", "skill-discovery", "code", "web"]) {
    assert.ok(shared.includes(n) && hb.includes(n), `${n} missing after consolidation`);
  }
});

// The skill/tool decoupling that makes the consolidation safe: heartbeat's ONE skill
// exclusion (schedule) lines up with the hard tool boundary (no schedule-cli), and
// mail carries the discord skill DOC now even though it has no discord-cli TOOL --
// a staged doc never grants a tool, so the tool grants remain the enforced boundary.
test("skill list and tool grants stay decoupled (docs don't grant tools)", () => {
  assert.ok(!HEARTBEAT_SKILL_SRCS.some((s) => basename(s) === "schedule"));
  assert.ok(!HEARTBEAT_TOOLS.includes("schedule-cli")); // the real, fail-closed boundary
  assert.ok(SKILL_NAMES.includes("discord")); // mail stages the discord doc...
  assert.ok(!MAIL_TOOLS.includes("discord-cli"), "...but has no discord-cli tool");
});

test("BAKED_SKILL_NAMES is exactly the staged skills (heartbeat is a subset of the shared list)", () => {
  const names = new Set([...SKILL_SRCS, ...HEARTBEAT_SKILL_SRCS].map((s) => basename(s)));
  assert.deepEqual([...BAKED_SKILL_NAMES].sort(), [...names].sort());
  assert.deepEqual([...BAKED_SKILL_NAMES].sort(), SKILL_NAMES.slice().sort()); // == the shared list's names
  // The guard is only sound if no surface stages a skill outside the floor.
  for (const srcs of [SKILL_SRCS, HEARTBEAT_SKILL_SRCS]) {
    for (const s of srcs) assert.ok(BAKED_SKILL_NAMES.has(basename(s)), `${s} not in the shadow-guard floor`);
  }
});

test("playwright-cli's skill resolves from the build dir, the rest from the repo skills dir", () => {
  const pw = SKILL_SRCS.find((s) => basename(s) === "playwright-cli");
  const web = SKILL_SRCS.find((s) => basename(s) === "web");
  assert.match(pw, /\.claude\/skills\/playwright-cli$/);
  assert.match(web, /\/skills\/web$/);
  assert.doesNotMatch(web, /\.claude/);
});
