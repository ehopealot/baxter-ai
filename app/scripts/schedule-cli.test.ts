import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseAdd } from "./schedule-cli.ts";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// Spawn the real CLI (spec tests 4-5, 17-18: the `groups` verb and the add-time
// refusal/grandfather behavior run against the process's own argv + env overrides).
function spawnScheduleCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [fileURLToPath(new URL("./schedule-cli.ts", import.meta.url)), ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("parseAdd requires exactly one of --cron/--at and at most one delivery", () => {
  assert.deepEqual(parseAdd(["do X", "--desc", "Do X", "--cron", "0 9 * * 1-5", "--discord", "123"]),
    { task: "do X", desc: "Do X", cron: "0 9 * * 1-5", at: null, tz: null, deliver: { surface: "discord", target: "123" } });
  assert.deepEqual(parseAdd(["ping", "--desc", "Ping", "--at", "2026-07-20T14:00:00Z", "--email", "e@x.com", "--tz", "America/New_York"]),
    { task: "ping", desc: "Ping", at: "2026-07-20T14:00:00Z", cron: null, tz: "America/New_York", deliver: { surface: "mail", target: "e@x.com" } });
  assert.throws(() => parseAdd(["x"]), /exactly one of --cron or --at/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--at", "2026-07-20T14:00:00Z"]), /exactly one of --cron or --at/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--discord", "1", "--email", "e@x"]), /one delivery/);
  assert.throws(() => parseAdd(["--cron", "0 9 * * *"]), /task description/); // empty description
});

test("parseAdd: --sms parses to an sms deliver target, and is mutually exclusive with --discord/--email", () => {
  assert.deepEqual(parseAdd(["text them", "--desc", "Text them", "--at", "2026-07-20T14:00:00Z", "--sms", "+15551234567"]),
    { task: "text them", desc: "Text them", at: "2026-07-20T14:00:00Z", cron: null, tz: null, deliver: { surface: "sms", target: "+15551234567" } });
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--sms", "+1555", "--discord", "1"]), /one delivery/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--sms", "+1555", "--email", "e@x"]), /one delivery/);
});

test("parseAdd requires --desc", () => {
  assert.throws(() => parseAdd(["do a thing", "--cron", "0 9 * * *"]), /--desc/);
  assert.throws(() => parseAdd(["do a thing", "--desc", "", "--cron", "0 9 * * *"]), /--desc/);
  assert.throws(() => parseAdd(["do a thing", "--desc", "   ", "--cron", "0 9 * * *"]), /--desc/);
});

test("parseAdd accepts --desc and returns it trimmed alongside task", () => {
  const p = parseAdd(["check weather then message family", "--desc", "  Morning weather check  ", "--cron", "0 8 * * *"]);
  assert.equal(p.task, "check weather then message family");
  assert.equal(p.desc, "Morning weather check");
  assert.equal(p.cron, "0 8 * * *");
});

// --- Scheduled-sms-group spec (2026-08-18): --sms-group + `groups` discovery --------------

test("parseAdd: --sms-group parses to an sms-group deliver target and is mutually exclusive with --discord/--email/--sms (spec test 5)", () => {
  assert.deepEqual(parseAdd(["daily digest", "--desc", "Digest", "--cron", "0 9 * * *", "--sms-group", "grp_abc"]),
    { task: "daily digest", desc: "Digest", cron: "0 9 * * *", at: null, tz: null, deliver: { surface: "sms-group", target: "grp_abc" } });
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--desc", "d", "--sms-group", "g", "--discord", "1"]), /one delivery/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--desc", "d", "--sms-group", "g", "--email", "e@x"]), /one delivery/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--desc", "d", "--sms-group", "g", "--sms", "+1555"]), /one delivery/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--desc", "d", "--sms-group"]), /missing value for --sms-group/);
});

test("parseAdd: an EMPTY --sms-group value is a present, invalid target -- never a silent deliver: null (spec §Error handling)", () => {
  // Presence, not truthiness: `--sms-group ''` must reach assertSmsGroupDeliverable's
  // strict gate, not degrade to an internal (deliver: null) task.
  assert.deepEqual(parseAdd(["x", "--cron", "0 9 * * *", "--desc", "d", "--sms-group", ""]),
    { task: "x", desc: "d", cron: "0 9 * * *", at: null, tz: null, deliver: { surface: "sms-group", target: "" } });
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--desc", "d", "--sms-group", "", "--sms", "+1555"]), /one delivery/);
  assert.throws(() => parseAdd(["x", "--cron", "0 9 * * *", "--desc", "d", "--sms-group", "", "--discord", "1"]), /one delivery/);
});

// A transcript-backed group to schedule into: a hand-written fixture file in the production
// g-<id>.jsonl layout (the grandfathered pre-feature shape -- writeFileSync, not the real
// append path), plus overrides for both stores.
function groupRig(): { dir: string; scheduleDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "sched-grp-"));
  const scheduleDir = mkdtempSync(join(tmpdir(), "sched-store-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  process.env.SCHEDULE_DIR_OVERRIDE = scheduleDir;
  writeFileSync(join(dir, "g-grp_hist.jsonl"), `${JSON.stringify({ direction: "in", at: "2026-01-01T00:00:00Z", content: "legacy", from: "+15550000000" })}\n`);
  return { dir, scheduleDir };
}
const endGroupRig = ({ dir, scheduleDir }: { dir: string; scheduleDir: string }) => {
  delete process.env.SMS_TRANSCRIPT_DIR_OVERRIDE;
  delete process.env.SCHEDULE_DIR_OVERRIDE;
  rmSync(dir, { recursive: true, force: true });
  rmSync(scheduleDir, { recursive: true, force: true });
};

test("add --sms-group: a transcript-backed group persists a task with the exact provider id (spec test 18: grandfathered eligibility)", () => {
  const rig = groupRig();
  try {
    const res = spawnScheduleCli(["add", "daily group digest", "--desc", "Group digest", "--cron", "0 9 * * *", "--sms-group", "grp_hist"]);
    assert.equal(res.status, 0, res.stderr);
    const tasks = JSON.parse(readFileSync(join(rig.scheduleDir, "schedule.json"), "utf8"));
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].deliver, { surface: "sms-group", target: "grp_hist" }, "the stored target is the exact provider group id, never a display name");
  } finally { endGroupRig(rig); }
});

test("add --sms-group refuses an invalid id or a transcript-less group BEFORE touching schedule.json (spec tests 5, 17)", () => {
  const rig = groupRig();
  try {
    const invalid = spawnScheduleCli(["add", "x", "--desc", "d", "--cron", "0 9 * * *", "--sms-group", "grp;evil"]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /not a valid group id/);
    assert.equal(existsSync(join(rig.scheduleDir, "schedule.json")), false, "no schedule.json is created for a refused id");
    // A strict id with no transcript is refused too (cold outbound not schedulable).
    const cold = spawnScheduleCli(["add", "x", "--desc", "d", "--cron", "0 9 * * *", "--sms-group", "grp_never_seen"]);
    assert.equal(cold.status, 1);
    assert.match(cold.stderr, /no transcript/);
    assert.equal(existsSync(join(rig.scheduleDir, "schedule.json")), false, "no schedule.json is created for a transcript-less group");
  } finally { endGroupRig(rig); }
});

test("add --sms-group '' is refused at the strict-id gate before any persistence (spec §Error handling)", () => {
  const rig = groupRig();
  try {
    const res = spawnScheduleCli(["add", "x", "--desc", "d", "--cron", "0 9 * * *", "--sms-group", ""]);
    assert.equal(res.status, 1, "an empty --sms-group value exits 1");
    assert.match(res.stderr, /not a valid group id/);
    assert.equal(existsSync(join(rig.scheduleDir, "schedule.json")), false, "no schedule.json is created -- nothing was persisted");
  } finally { endGroupRig(rig); }
});

test("add --sms-group: a quarantined inbound does NOT make its stripped form schedulable (spec test 13)", async () => {
  const rig = groupRig();
  try {
    // The inbound landed under gx-977da...jsonl (the handleInbound path is covered in
    // sms-bot.test.ts); simulate the resulting disk state: NO g-grpevil.jsonl exists.
    const res = spawnScheduleCli(["add", "x", "--desc", "d", "--cron", "0 9 * * *", "--sms-group", "grpevil"]);
    assert.equal(res.status, 1, "the collision target is not schedulable -- no strict transcript backs it");
    assert.match(res.stderr, /no transcript/);
    assert.equal(existsSync(join(rig.scheduleDir, "schedule.json")), false);
  } finally { endGroupRig(rig); }
});

test("schedule-cli groups prints the summary array as JSON with no message bodies (spec test 4)", () => {
  const rig = groupRig();
  try {
    writeFileSync(join(rig.dir, "g-grp_new.jsonl"), `${JSON.stringify({ direction: "in", at: "2026-08-01T10:00:00Z", content: "secret body text", media_url: "https://m.example/x.jpg", from: "+15551234567", group_id: "grp_new", group_name: "Fam", participants: ["+15551234567", "+15550000000"] })}\n`);
    // Quarantined + junk files must not leak into the output.
    writeFileSync(join(rig.dir, "gx-977da2f04cb79fc6671c7a317c40a42db07ee763cf42951ac15e8761480afbe5.jsonl"), `${JSON.stringify({ direction: "in", at: "2026-08-02T10:00:00Z", content: "quarantined body", from: "+1", group_id: "grp;evil", group_name: "Evil" })}\n`);
    writeFileSync(join(rig.dir, "g-bad;name.jsonl"), `${JSON.stringify({ direction: "in", at: "2026-08-03T10:00:00Z", content: "junk", from: "+1" })}\n`);
    const res = spawnScheduleCli(["groups"]);
    assert.equal(res.status, 0, res.stderr);
    const summaries = JSON.parse(res.stdout);
    // grp_new is newer than the grandfathered grp_hist -> first.
    assert.deepEqual(summaries.map((s: { id: string }) => s.id), ["grp_new", "grp_hist"]);
    assert.deepEqual(summaries[0], { id: "grp_new", name: "Fam", participants: ["+15551234567", "+15550000000"], speakers: ["+15551234567"], lastActivity: "2026-08-01T10:00:00Z" });
    assert.equal(summaries[1].name, null, "the legacy group has no name");
    // Discovery output never carries message bodies or media urls.
    assert.ok(!res.stdout.includes("secret body text") && !res.stdout.includes("quarantined body") && !res.stdout.includes("junk"));
    assert.ok(!res.stdout.includes("media_url"));
  } finally { endGroupRig(rig); }
});

test("schedule-cli groups returns [] when there are no valid group transcripts", () => {
  const rig = groupRig();
  try {
    rmSync(join(rig.dir, "g-grp_hist.jsonl"));
    const res = spawnScheduleCli(["groups"]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "[]");
  } finally { endGroupRig(rig); }
});

test("every scheduling-capable guidance surface documents group discovery and ambiguity handling (spec test 10)", () => {
  // The schedule skill + every prompt whose surface holds the schedule-cli grant (email,
  // Discord -- including its reaction runs -- chat, SMS, and TUI; the voice-DISPATCH run
  // holds the grant too via DISCORD_TOOLS, but its prompt is code-built in
  // renderVoiceDispatchPrompt -- no .md entry belongs in this list). The heartbeat prompt
  // is delivery-only (its guidance is pinned in heartbeat.test.ts); the TUI onboarding
  // prompt runs tool-free (`allowedTools: ""`) and stays excluded; the PRODUCTION mail
  // prompt is a code-built line array, so its rendered output is asserted in
  // mail-bot.test.ts (the prompt.md entry here is the mail EVAL template only, per
  // app/CLAUDE.md); likewise the PRODUCTION voice-dispatch prompt is asserted in
  // voice-bot.test.ts (same convention: the rendered, code-built prompt is the contract).
  const files = [
    "skills/schedule/SKILL.md",
    "prompt.md",
    "discord-prompt.md",
    "chat-prompt.md",
    "sms-prompt.md",
    "tui-prompt.md",
    "discord-reaction-prompt.md",
  ];
  for (const f of files) {
    const raw = readFileSync(join(APP_DIR, f), "utf8");
    assert.ok(raw.includes("schedule-cli groups"), `${f} must document the groups discovery verb`);
    assert.ok(raw.includes("--sms-group"), `${f} must document the --sms-group delivery flag`);
    assert.ok(/ask (them|the requester|which one|whichever)/i.test(raw) || raw.includes("asking"), `${f} must tell the run to ASK when several groups are plausible rather than guess`);
  }
});
