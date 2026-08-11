import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import {
  MAIL_TOOLS, DISCORD_TOOLS, HEARTBEAT_TOOLS, TUI_TOOLS, SMS_TOOLS, CHAT_TOOLS,
  MAIL_SKILL_SRCS, DISCORD_SKILL_SRCS, HEARTBEAT_SKILL_SRCS, TUI_SKILL_SRCS, SMS_SKILL_SRCS, CHAT_SKILL_SRCS, SKILL_NAMES,
  MAIL_SKILL_NAMES, DISCORD_SKILL_NAMES, HEARTBEAT_SKILL_NAMES, TUI_SKILL_NAMES, SMS_SKILL_NAMES, CHAT_SKILL_NAMES, loadedSkillsList,
  BAKED_SKILL_NAMES,
} from "./grants.ts";

test("each surface's SKILL_SRCS derive from its SKILL_NAMES (no drift), and skill-creator is surfaced", () => {
  // SRCS are derived from NAMES, so the dirs staged and the list the prompt advertises
  // can't diverge (review d1d2a87 F2).
  assert.deepEqual(MAIL_SKILL_SRCS.map((s) => basename(s)), MAIL_SKILL_NAMES);
  assert.deepEqual(DISCORD_SKILL_SRCS.map((s) => basename(s)), DISCORD_SKILL_NAMES);
  assert.deepEqual(HEARTBEAT_SKILL_SRCS.map((s) => basename(s)), HEARTBEAT_SKILL_NAMES);
  // regression guard for the discovery bug: a make-add-skill skill reaches the prompt list
  assert.ok(loadedSkillsList(DISCORD_SKILL_NAMES).includes("`skill-creator`"));
  // help-user-setup (onboarding walkthrough) is staged on EVERY surface -- it's in the
  // base list, excluded by none, so mail/discord/heartbeat/tui all carry it.
  for (const names of [MAIL_SKILL_NAMES, DISCORD_SKILL_NAMES, HEARTBEAT_SKILL_NAMES, TUI_SKILL_NAMES]) {
    assert.ok(names.includes("help-user-setup"), "help-user-setup must be staged on every surface");
  }
});

// The tool strings are a security boundary; these lock in the deliberate
// per-surface asymmetries that used to live in three separate inline strings.
test("every surface grants the shared core tools", () => {
  for (const tools of [MAIL_TOOLS, DISCORD_TOOLS, HEARTBEAT_TOOLS]) {
    for (const t of ["Bash(code-cli *)", "Bash(files-cli *)", "Bash(projects-cli *)", "Bash(memory-cli *)", "Bash(calendar-cli *)", "Bash(checklist-cli *)", "Bash(recipes-cli *)", "Bash(link-cli *)", "Bash(data-cli *)", "Bash(skills-cli *)", "Bash(web-cli *)", "Bash(playwright-cli *)", "Bash(invisible-cli *)", "WebSearch", "WebFetch", "Skill", "Read", "Write", "Edit"]) {
      assert.ok(tools.includes(t), `${t} missing from ${tools}`);
    }
  }
});

test("mail grants mail + schedule-cli, never discord", () => {
  assert.match(MAIL_TOOLS, /Bash\(node \S*mail-cli\.ts \*\)/);
  assert.ok(MAIL_TOOLS.includes("Bash(mail-cli *)"));
  assert.ok(MAIL_TOOLS.includes("Bash(schedule-cli *)"));
  assert.ok(!MAIL_TOOLS.includes("discord-cli"), "mail must not grant discord");
});

test("discord grants discord + schedule-cli, never mail", () => {
  assert.match(DISCORD_TOOLS, /Bash\(node \S*discord-cli\.ts \*\)/);
  assert.ok(DISCORD_TOOLS.includes("Bash(discord-cli *)"));
  assert.ok(DISCORD_TOOLS.includes("Bash(schedule-cli *)"));
  assert.ok(!DISCORD_TOOLS.includes("mail.ts"), "discord must not grant mail");
});

test("tui grants the generous operator union (mail + discord + schedule + all core) and all baked skills", () => {
  for (const t of ["Bash(schedule-cli *)", "Bash(discord-cli *)", "Bash(code-cli *)", "Bash(files-cli *)", "Bash(projects-cli *)", "Bash(memory-cli *)", "Bash(calendar-cli *)", "Bash(checklist-cli *)", "Bash(recipes-cli *)", "Bash(link-cli *)", "Bash(data-cli *)", "Skill", "Read", "Write", "Edit"]) {
    assert.ok(TUI_TOOLS.includes(t), `${t} missing from TUI_TOOLS`);
  }
  assert.match(TUI_TOOLS, /Bash\(node \S*mail-cli\.ts \*\)/);
  assert.ok(TUI_TOOLS.includes("Bash(mail-cli *)"));
  assert.match(TUI_TOOLS, /Bash\(node \S*discord-cli\.ts \*\)/);
  // operator surface excludes nothing -> all baked skills, derived from NAMES like the rest
  assert.deepEqual(TUI_SKILL_NAMES.slice().sort(), SKILL_NAMES.slice().sort());
  assert.deepEqual(TUI_SKILL_SRCS.map((s) => basename(s)), TUI_SKILL_NAMES);
});

test("heartbeat grants mail + discord + sms but NOT schedule-cli (a fired task can't schedule)", () => {
  assert.match(HEARTBEAT_TOOLS, /Bash\(node \S*mail-cli\.ts \*\)/);
  assert.ok(HEARTBEAT_TOOLS.includes("Bash(mail-cli *)"));
  assert.match(HEARTBEAT_TOOLS, /Bash\(node \S*discord-cli\.ts \*\)/);
  assert.ok(HEARTBEAT_TOOLS.includes("Bash(discord-cli *)"));
  assert.match(HEARTBEAT_TOOLS, /Bash\(node \S*sms-cli\.ts \*\)/);
  assert.ok(HEARTBEAT_TOOLS.includes("Bash(sms-cli *)"));
  assert.ok(!HEARTBEAT_TOOLS.includes("schedule-cli"), "a fired task must not schedule/cancel tasks");
});

test("each surface filters the ONE base list by its own exclusions (mail -discord, heartbeat -schedule, discord none)", () => {
  const names = (srcs: string[]) => srcs.map((s) => basename(s)).sort();
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
  const has = (srcs: string[], n: string) => srcs.some((s) => basename(s) === n);
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

test("sms excludes `discord` (no discord-cli in SMS_TOOLS, mirrors mail's exclusion)", () => {
  // Review finding: SMS has no discord-cli on its allow-list, so advertising the
  // `discord` skill as loaded made the model waste turns on denied commands (the
  // correct cross-surface path is scheduling a heartbeat task, which HAS
  // discord-cli). SMS_SKILL_SRCS and the prompt's LOADED_SKILLS both derive from
  // SMS_SKILL_NAMES, so asserting the NAMES list is enough to cover both.
  assert.ok(!SMS_SKILL_NAMES.includes("discord"), "SMS_SKILL_NAMES must not include discord");
  assert.ok(!SMS_TOOLS.includes("discord-cli"), "SMS_TOOLS must not grant discord-cli");
  assert.deepEqual(SMS_SKILL_SRCS.map((s) => basename(s)), SMS_SKILL_NAMES);
  assert.deepEqual(SMS_SKILL_NAMES.slice().sort(), SKILL_NAMES.filter((n) => n !== "discord").sort());
});

test("chat grants chat-cli + schedule-cli + core tools, mirrors SMS_TOOLS", () => {
  assert.match(CHAT_TOOLS, /Bash\(node \S*chat-cli\.ts \*\)/);
  assert.ok(CHAT_TOOLS.includes("Bash(chat-cli *)"));
  assert.ok(CHAT_TOOLS.includes("Bash(schedule-cli *)"));
  for (const t of ["Bash(code-cli *)", "Bash(files-cli *)", "Bash(projects-cli *)", "Bash(memory-cli *)", "Bash(calendar-cli *)", "Bash(checklist-cli *)", "Bash(recipes-cli *)", "Bash(link-cli *)", "Bash(data-cli *)", "Bash(skills-cli *)", "Bash(web-cli *)", "Bash(playwright-cli *)", "Bash(invisible-cli *)", "WebSearch", "WebFetch", "Skill", "Read", "Write", "Edit"]) {
    assert.ok(CHAT_TOOLS.includes(t), `${t} missing from CHAT_TOOLS`);
  }
});

test("chat excludes `discord` (no discord-cli in CHAT_TOOLS, mirrors sms's exclusion)", () => {
  // Same rationale as SMS: chat has no discord-cli on its allow-list, so the `discord`
  // skill must not be advertised as loaded either. CHAT_SKILL_SRCS and the prompt's
  // LOADED_SKILLS both derive from CHAT_SKILL_NAMES, so asserting the NAMES list covers both.
  assert.ok(!CHAT_SKILL_NAMES.includes("discord"), "CHAT_SKILL_NAMES must not include discord");
  assert.ok(!CHAT_TOOLS.includes("discord-cli"), "CHAT_TOOLS must not grant discord-cli");
  assert.deepEqual(CHAT_SKILL_SRCS.map((s) => basename(s)), CHAT_SKILL_NAMES);
  assert.deepEqual(CHAT_SKILL_NAMES.slice().sort(), SKILL_NAMES.filter((n) => n !== "discord").sort());
});

test("chat never grants sms-cli or mail (mirrors sms's own exclusions of discord/mail)", () => {
  assert.ok(!CHAT_TOOLS.includes("sms-cli"), "CHAT_TOOLS must not grant sms-cli");
  assert.ok(!CHAT_TOOLS.includes("mail.ts"), "CHAT_TOOLS must not grant mail");
});

test("playwright-cli's skill resolves from the build dir, the rest from the repo skills dir", () => {
  const pw = DISCORD_SKILL_SRCS.find((s) => basename(s) === "playwright-cli");
  const web = DISCORD_SKILL_SRCS.find((s) => basename(s) === "web");
  assert.match(pw!, /\.claude\/skills\/playwright-cli$/);
  assert.match(web!, /\/skills\/web$/);
  assert.doesNotMatch(web!, /\.claude/);
});
