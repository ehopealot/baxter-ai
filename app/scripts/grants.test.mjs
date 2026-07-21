import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import {
  MAIL_TOOLS, DISCORD_TOOLS, HEARTBEAT_TOOLS,
  MAIL_SKILL_SRCS, DISCORD_SKILL_SRCS, HEARTBEAT_SKILL_SRCS,
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

test("BAKED_SKILL_NAMES is exactly the union of the three surfaces' staged skills", () => {
  const union = new Set(
    [...MAIL_SKILL_SRCS, ...DISCORD_SKILL_SRCS, ...HEARTBEAT_SKILL_SRCS].map((s) => basename(s)),
  );
  assert.deepEqual([...BAKED_SKILL_NAMES].sort(), [...union].sort());
  // The guard is only sound if no surface stages a skill outside the floor.
  for (const srcs of [MAIL_SKILL_SRCS, DISCORD_SKILL_SRCS, HEARTBEAT_SKILL_SRCS]) {
    for (const s of srcs) assert.ok(BAKED_SKILL_NAMES.has(basename(s)), `${s} not in the shadow-guard floor`);
  }
});

test("playwright-cli's skill resolves from the build dir, the rest from the repo skills dir", () => {
  const pw = MAIL_SKILL_SRCS.find((s) => basename(s) === "playwright-cli");
  const web = MAIL_SKILL_SRCS.find((s) => basename(s) === "web");
  assert.match(pw, /\.claude\/skills\/playwright-cli$/);
  assert.match(web, /\/skills\/web$/);
  assert.doesNotMatch(web, /\.claude/);
});
