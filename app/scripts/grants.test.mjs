import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import {
  MAIL_TOOLS, DISCORD_TOOLS, HEARTBEAT_TOOLS,
  MAIL_SKILL_SRCS, DISCORD_SKILL_SRCS, HEARTBEAT_SKILL_SRCS, SKILL_NAMES,
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

test("mail grants mail + schedule-cli, never discord", () => {
  assert.match(MAIL_TOOLS, /Bash\(node \S*mail\.mjs \*\)/);
  assert.ok(MAIL_TOOLS.includes("Bash(schedule-cli *)"));
  assert.ok(!MAIL_TOOLS.includes("discord-cli"), "mail must not grant discord");
});

test("discord grants discord + schedule-cli, never mail", () => {
  assert.match(DISCORD_TOOLS, /Bash\(node \S*discord-cli\.mjs \*\)/);
  assert.ok(DISCORD_TOOLS.includes("Bash(discord-cli *)"));
  assert.ok(DISCORD_TOOLS.includes("Bash(schedule-cli *)"));
  assert.ok(!DISCORD_TOOLS.includes("mail.mjs"), "discord must not grant mail");
});

test("heartbeat grants mail + discord but NOT schedule-cli (a fired task can't schedule)", () => {
  assert.match(HEARTBEAT_TOOLS, /Bash\(node \S*mail\.mjs \*\)/);
  assert.match(HEARTBEAT_TOOLS, /Bash\(node \S*discord-cli\.mjs \*\)/);
  assert.ok(HEARTBEAT_TOOLS.includes("Bash(discord-cli *)"));
  assert.ok(!HEARTBEAT_TOOLS.includes("schedule-cli"), "a fired task must not schedule/cancel tasks");
});

test("each surface filters the ONE base list by its own exclusions (mail -discord, heartbeat -schedule, discord none)", () => {
  const names = (srcs) => srcs.map((s) => basename(s)).sort();
  const base = SKILL_NAMES.slice().sort();
  assert.deepEqual(names(DISCORD_SKILL_SRCS), base, "discord stages the whole base list");
  assert.deepEqual(names(MAIL_SKILL_SRCS), SKILL_NAMES.filter((n) => n !== "discord").sort());
  assert.deepEqual(names(HEARTBEAT_SKILL_SRCS), SKILL_NAMES.filter((n) => n !== "schedule").sort());
  // spell out the two exclusions
  assert.ok(!names(MAIL_SKILL_SRCS).includes("discord"), "mail excludes discord");
  assert.ok(names(MAIL_SKILL_SRCS).includes("schedule"), "mail keeps schedule");
  assert.ok(!names(HEARTBEAT_SKILL_SRCS).includes("schedule"), "heartbeat excludes schedule");
  assert.ok(names(HEARTBEAT_SKILL_SRCS).includes("discord"), "heartbeat keeps discord");
});

// Each skill exclusion mirrors a missing tool, and the tool grant -- not the doc --
// is the enforced, fail-closed boundary (a staged doc never grants its tool).
test("skill exclusions line up with the tool grants they mirror", () => {
  const has = (srcs, n) => srcs.some((s) => basename(s) === n);
  assert.ok(!has(HEARTBEAT_SKILL_SRCS, "schedule") && !HEARTBEAT_TOOLS.includes("schedule-cli"), "heartbeat: no schedule skill AND no schedule-cli");
  assert.ok(!has(MAIL_SKILL_SRCS, "discord") && !MAIL_TOOLS.includes("discord-cli"), "mail: no discord skill AND no discord-cli");
  assert.ok(has(DISCORD_SKILL_SRCS, "discord") && DISCORD_TOOLS.includes("Bash(discord-cli *)"), "discord: has both");
  assert.ok(has(DISCORD_SKILL_SRCS, "schedule") && DISCORD_TOOLS.includes("Bash(schedule-cli *)"), "discord: has both");
});

test("BAKED_SKILL_NAMES is exactly the base list (the union of the subset surfaces)", () => {
  const union = new Set([...MAIL_SKILL_SRCS, ...DISCORD_SKILL_SRCS, ...HEARTBEAT_SKILL_SRCS].map((s) => basename(s)));
  assert.deepEqual([...BAKED_SKILL_NAMES].sort(), [...union].sort());
  assert.deepEqual([...BAKED_SKILL_NAMES].sort(), SKILL_NAMES.slice().sort());
  // The guard is only sound if no surface stages a skill outside the floor.
  for (const srcs of [MAIL_SKILL_SRCS, DISCORD_SKILL_SRCS, HEARTBEAT_SKILL_SRCS]) {
    for (const s of srcs) assert.ok(BAKED_SKILL_NAMES.has(basename(s)), `${s} not in the shadow-guard floor`);
  }
});

test("playwright-cli's skill resolves from the build dir, the rest from the repo skills dir", () => {
  const pw = DISCORD_SKILL_SRCS.find((s) => basename(s) === "playwright-cli");
  const web = DISCORD_SKILL_SRCS.find((s) => basename(s) === "web");
  assert.match(pw, /\.claude\/skills\/playwright-cli$/);
  assert.match(web, /\/skills\/web$/);
  assert.doesNotMatch(web, /\.claude/);
});
