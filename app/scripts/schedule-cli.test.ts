import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseAdd, cmdSystemList, cmdSystemEnable, cmdSystemDisable, cmdSystemTrigger, cmdCancel } from "./schedule-cli.ts";
import type { Task } from "./schedule-store.ts";
import { ReservedIdCollisionError } from "./system-reconcile.ts";
import type { SystemTaskDefinition } from "./system-tasks.ts";

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

// --- System task controls (2026-08-20 system scheduled tasks, T5) --------------------------
// `schedule-cli system list|enable|disable <key>`: each command reconciles the
// reserved namespace INSIDE the same mutate() transaction as its own read/toggle
// (one atomic unit under the store lock). These tests run IN-PROCESS against an
// INJECTED test registry via the cmd functions' registry parameter (SYSTEM_TASKS
// holds the real morning check-in -- production registration state must never
// leak in) and an injected clock for the deterministic before/after-08:00 cases,
// under a temp SCHEDULE_DIR_OVERRIDE with BAXTER_TZ pinned. 2026-08-20 is a
// Thursday; PDT is UTC-7 all August, so 08:00 PDT = 15:00Z.

const SYS_TZ = "America/Los_Angeles";
const BEFORE_0800 = new Date("2026-08-20T13:00:00Z"); // 06:00 PDT
const AFTER_0800 = new Date("2026-08-20T16:00:00Z"); // 09:00 PDT
const TODAY_0800 = "2026-08-20T15:00:00.000Z";
const TOMORROW_0800 = "2026-08-21T15:00:00.000Z";

const digestDef: SystemTaskDefinition<"test-daily-digest"> = {
  key: "test-daily-digest",
  desc: "Here’s what’s on the calendar",
  cron: "0 8 * * *",
  execute: async () => ({ ok: true }),
};
const TEST_REGISTRY: readonly SystemTaskDefinition<string>[] = [digestDef];

const sysOrdinary = (id: string, over: Partial<Task> = {}): Task => ({
  id, task: "an ordinary task", cron: "0 9 * * *", at: null, tz: SYS_TZ,
  next_run_at: TOMORROW_0800, invisible_until: null, attempts: 0, deliver: null,
  created_at: "2026-08-01T00:00:00.000Z", ...over,
});
const canonicalDigest = (over: Partial<Task> = {}): Task => ({
  id: "system:test-daily-digest", desc: "Here’s what’s on the calendar", cron: "0 8 * * *", at: null, tz: SYS_TZ,
  next_run_at: TODAY_0800, invisible_until: null, attempts: 0, deliver: null,
  system: { key: "test-daily-digest", enabled: true }, created_at: "2026-08-01T00:00:00.000Z", ...over,
});

function sysRig(tasks: Task[] = []): { dir: string; store: string; prev: Record<string, string | undefined> } {
  const dir = mkdtempSync(join(tmpdir(), "sched-cli-sys-"));
  const prev: Record<string, string | undefined> = {
    SCHEDULE_DIR_OVERRIDE: process.env.SCHEDULE_DIR_OVERRIDE,
    BAXTER_TZ: process.env.BAXTER_TZ,
    HEARTBEAT_TZ: process.env.HEARTBEAT_TZ,
  };
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  process.env.BAXTER_TZ = SYS_TZ; // householdTz: valid BAXTER_TZ wins
  delete process.env.HEARTBEAT_TZ;
  const store = join(dir, "schedule.json");
  if (tasks.length > 0) writeFileSync(store, JSON.stringify(tasks, null, 2));
  return { dir, store, prev };
}
const endSysRig = (rig: { dir: string; prev: Record<string, string | undefined> }) => {
  for (const [k, v] of Object.entries(rig.prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(rig.dir, { recursive: true, force: true });
};
const readStore = (p: string): Task[] => JSON.parse(readFileSync(p, "utf8")) as Task[];

const isCollision = (err: unknown): boolean =>
  err instanceof ReservedIdCollisionError && /collision/.test((err as Error).message);

test("system list reconciles a fresh store in one transaction and reports the canonical record", async () => {
  const rig = sysRig();
  try {
    const summaries = await cmdSystemList(TEST_REGISTRY, BEFORE_0800);
    assert.deepEqual(summaries, [
      { key: "test-daily-digest", desc: "Here’s what’s on the calendar", enabled: true, next_run_at: TODAY_0800 },
    ]);
    // The same transaction persisted the canonical record -- one write, never two
    // separately locked steps.
    const tasks = readStore(rig.store);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, "system:test-daily-digest");
    assert.equal(tasks[0].system?.key, "test-daily-digest");
    assert.ok(tasks[0].system?.enabled === true);
    assert.equal(tasks[0].next_run_at, TODAY_0800); // the definition's own cron catch-up anchor
  } finally { endSysRig(rig); }
});

test("system disable before heartbeat's first start creates the canonical record ALREADY disabled", async () => {
  const rig = sysRig();
  try {
    const res = await cmdSystemDisable("test-daily-digest", TEST_REGISTRY, BEFORE_0800);
    assert.equal(res.enabled, false);
    assert.equal(typeof res.enabled, "boolean");
    const tasks = readStore(rig.store);
    assert.equal(tasks.length, 1);
    // What PERSISTED is disabled: creation and toggle are one transaction, so no
    // briefly-enabled record ever hits a store where heartbeat never ran.
    assert.ok(tasks[0].system?.enabled === false);
    assert.equal(typeof tasks[0].system?.enabled, "boolean");
    assert.equal(tasks[0].next_run_at, TODAY_0800); // reconcile's cron-derived anchor, never a CLI-local 08:00 literal
    assert.equal(tasks[0].invisible_until, null);
    assert.equal(tasks[0].attempts, 0);
  } finally { endSysRig(rig); }
});

test("system disable clears claim/retry state on an existing canonical record but keeps its queue progress", async () => {
  const rig = sysRig([canonicalDigest({ invisible_until: "2026-08-20T20:00:00.000Z", attempts: 2 })]);
  try {
    const res = await cmdSystemDisable("test-daily-digest", TEST_REGISTRY, AFTER_0800);
    assert.equal(res.enabled, false);
    const [rec] = readStore(rig.store);
    assert.equal(rec.system?.enabled, false);
    assert.equal(rec.invisible_until, null);
    assert.equal(rec.attempts, 0);
    assert.equal(rec.next_run_at, TODAY_0800); // disable never recomputes next_run_at
  } finally { endSysRig(rig); }
});

test("system enable after 08:00 schedules tomorrow's 08:00 and writes literal booleans", async () => {
  const rig = sysRig();
  try {
    await cmdSystemDisable("test-daily-digest", TEST_REGISTRY, BEFORE_0800); // next_run_at now today's (past) 08:00
    const res = await cmdSystemEnable("test-daily-digest", TEST_REGISTRY, AFTER_0800);
    assert.equal(res.enabled, true);
    assert.equal(typeof res.enabled, "boolean");
    const [rec] = readStore(rig.store);
    assert.ok(rec.system?.enabled === true, "literal boolean true persisted");
    assert.equal(rec.next_run_at, TOMORROW_0800); // strictly-after-now via resolveNextRun
    assert.equal(rec.invisible_until, null);
    assert.equal(rec.attempts, 0);
  } finally { endSysRig(rig); }
});

test("system list reports the NORMALIZED literal state when the persisted enabled was the string 'true'", async () => {
  const malformed = { ...canonicalDigest(), system: { key: "test-daily-digest", enabled: "true" } } as unknown as Task;
  const rig = sysRig([malformed]);
  try {
    const summaries = await cmdSystemList(TEST_REGISTRY, AFTER_0800);
    assert.equal(summaries[0].enabled, false); // the repaired literal, never the raw malformed value
    assert.equal(typeof summaries[0].enabled, "boolean");
    const [rec] = readStore(rig.store);
    assert.ok(rec.system?.enabled === false);
    assert.equal(typeof rec.system?.enabled, "boolean");
  } finally { endSysRig(rig); }
});

test("system enable/disable refuse an unknown key or an ordinary-task argument without touching the store", async () => {
  const rig = sysRig([sysOrdinary("ab12cd34")]);
  try {
    const before = readFileSync(rig.store, "utf8");
    await assert.rejects(cmdSystemEnable("no-such-task", TEST_REGISTRY, AFTER_0800), /unknown system task key/);
    await assert.rejects(cmdSystemDisable("no-such-task", TEST_REGISTRY, AFTER_0800), /unknown system task key/);
    await assert.rejects(cmdSystemEnable("ab12cd34", TEST_REGISTRY, AFTER_0800), /not a system task/);
    await assert.rejects(cmdSystemDisable("ab12cd34", TEST_REGISTRY, AFTER_0800), /not a system task/);
    assert.equal(readFileSync(rig.store, "utf8"), before, "no byte changed");
    assert.equal(readStore(rig.store).length, 1, "a refusal never creates the canonical record");
  } finally { endSysRig(rig); }
});

test("a reserved-id collision makes system list/enable/disable all refuse with no mutation, while plain list still works", async () => {
  const rig = sysRig([sysOrdinary("system:other")]);
  try {
    const before = readFileSync(rig.store, "utf8");
    await assert.rejects(() => cmdSystemList(TEST_REGISTRY, AFTER_0800), isCollision);
    await assert.rejects(() => cmdSystemEnable("test-daily-digest", TEST_REGISTRY, AFTER_0800), isCollision);
    await assert.rejects(() => cmdSystemDisable("test-daily-digest", TEST_REGISTRY, AFTER_0800), isCollision);
    assert.equal(readFileSync(rig.store, "utf8"), before, "the throw happens inside the transaction -- nothing written");
    // Plain `schedule-cli list` performs no reconciliation and stays available for diagnosis.
    const res = spawnScheduleCli(["list"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /system:other/);
  } finally { endSysRig(rig); }
});

test("cancel refuses a genuine system record and a duplicated id, without mutation", async () => {
  const rig = sysRig([
    canonicalDigest(),
    sysOrdinary("dup1"),
    { ...sysOrdinary("dup1"), created_at: "2026-08-02T00:00:00.000Z" },
  ]);
  try {
    const before = readFileSync(rig.store, "utf8");
    await assert.rejects(cmdCancel("system:test-daily-digest", TEST_REGISTRY), /system tasks cannot be cancelled/);
    await assert.rejects(cmdCancel("dup1", TEST_REGISTRY), /ambiguous id: 2 records share dup1/);
    assert.equal(readFileSync(rig.store, "utf8"), before);
  } finally { endSysRig(rig); }
});

test("cancel reports failure and preserves the store when no ordinary task matches", () => {
  const rig = sysRig([sysOrdinary("keep1")]);
  try {
    const before = readFileSync(rig.store, "utf8");
    const result = spawnScheduleCli(["cancel", "missing"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no task with id missing/);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(rig.store, "utf8"), before, "no-match cancellation does not rewrite the store");
  } finally { endSysRig(rig); }
});

test("cancel clears one unambiguous ordinary reserved-id record, after which reconciliation completes cleanly (CLI-level repair path)", async () => {
  const rig = sysRig([sysOrdinary("system:other")]);
  try {
    await cmdCancel("system:other", TEST_REGISTRY);
    assert.equal(readStore(rig.store).length, 0, "the ordinary record under the reserved id is gone");
    // The next system command (same shape as the heartbeat gate) now reconciles
    // cleanly and creates the canonical record.
    const summaries = await cmdSystemList(TEST_REGISTRY, AFTER_0800);
    assert.equal(summaries[0].key, "test-daily-digest");
    assert.equal(summaries[0].enabled, true);
    const tasks = readStore(rig.store);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, "system:test-daily-digest");
  } finally { endSysRig(rig); }
});

test("cancel still aborts with no write when a DIFFERENT collision remains after excluding the cancelled record", async () => {
  const rig = sysRig([sysOrdinary("system:other"), sysOrdinary("system:zzz")]);
  try {
    const before = readFileSync(rig.store, "utf8");
    await assert.rejects(cmdCancel("system:other", TEST_REGISTRY), ReservedIdCollisionError);
    assert.equal(readFileSync(rig.store, "utf8"), before, "no write");
  } finally { endSysRig(rig); }
});

test("add's MAX_TASKS count exempts ONLY canonical registered system records", () => {
  const rig = sysRig([sysOrdinary("ab12cd34"), {
    ...canonicalDigest(), id: "system:morning-check-in", desc: "Morning calendar and household check-in",
    system: { key: "morning-check-in", enabled: true },
  }]);
  let rig2: ReturnType<typeof sysRig> | null = null;
  try {
    // 1 ordinary + 1 canonical system record with MAX_TASKS=2: the canonical record
    // is exempt, so add still fits.
    const res = spawnScheduleCli(
      ["add", "third task", "--desc", "Third", "--cron", "0 9 * * *"],
      { HEARTBEAT_MAX_TASKS: "2" },
    );
    assert.equal(res.status, 0, res.stderr);
    const tasks = readStore(rig.store);
    assert.equal(tasks.length, 3);
    const added = tasks.find((t) => t.desc === "Third")!;
    assert.ok(!added.id.startsWith("system:"), "add mints ordinary ids via mintTaskId");
    // An unknown-key record on a NON-reserved id carrying system metadata is NOT
    // exempt: reconciliation keeps it visible but never executes it, so it still
    // consumes the cap.
    const ghost = sysOrdinary("beefcafe", { system: { key: "ghost-task", enabled: true } });
    rig2 = sysRig([sysOrdinary("ab12cd34"), ghost]);
    const before = readFileSync(rig2.store, "utf8");
    const refused = spawnScheduleCli(
      ["add", "third task", "--desc", "Third", "--cron", "0 9 * * *"],
      { HEARTBEAT_MAX_TASKS: "2" },
    );
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /schedule is full/);
    assert.equal(readFileSync(rig2.store, "utf8"), before, "a refused add writes nothing");
  } finally {
    if (rig2) endSysRig(rig2);
    endSysRig(rig);
  }
});

test("system enable is idempotent: empty reconciliation selects once, repeated enable preserves bytes, and false-to-true selects once", async () => {
  const ranged: SystemTaskDefinition<string> = { key: "morning-check-in", desc: "Morning calendar and household check-in", cron: "0 8 * * *", window: { startHour: 8, minuteSlots: 60, cutoffHour: 12 }, execute: async () => ({ ok: true }) };
  const rig = sysRig();
  try {
    let selections = 0;
    const selector = () => { selections++; return 17; };
    await cmdSystemEnable("morning-check-in", [ranged], BEFORE_0800, selector);
    assert.equal(selections, 1, "empty-store reconciliation supplies the only selection");
    const first = readStore(rig.store)[0]!;
    const firstBytes = JSON.stringify(first);
    await cmdSystemEnable("morning-check-in", [ranged], BEFORE_0800, () => { throw new Error("must not reselect"); });
    assert.equal(JSON.stringify(readStore(rig.store)[0]), firstBytes, "already enabled record is byte-stable");
    await cmdSystemDisable("morning-check-in", [ranged], BEFORE_0800);
    const disabled = { ...readStore(rig.store)[0]!, invisible_until: "2026-08-20T18:00:00.000Z", attempts: 2 };
    writeFileSync(rig.store, JSON.stringify([disabled]));
    const enabled = await cmdSystemEnable("morning-check-in", [ranged], AFTER_0800, selector);
    assert.equal(selections, 2, "literal false-to-true transition selects exactly once");
    const transitioned = readStore(rig.store)[0]!;
    assert.equal(enabled.next_run_at, "2026-08-21T15:17:00.000Z");
    assert.equal(transitioned.invisible_until, null);
    assert.equal(transitioned.attempts, 0);
    assert.notEqual(transitioned.next_run_at, disabled.next_run_at);
  } finally { endSysRig(rig); }
});

test("morning disable prevents dispatch state, enable selects a future range, and trigger leaves canonical bytes unchanged", async () => {
  const morning: SystemTaskDefinition<string> = { key: "morning-check-in", desc: "Morning calendar and household check-in", cron: "0 8 * * *", window: { startHour: 8, minuteSlots: 60, cutoffHour: 12 }, execute: async () => ({ ok: true }) };
  const canonical = { ...canonicalDigest({ id: "system:morning-check-in", desc: morning.desc, system: { key: "morning-check-in", enabled: true }, next_run_at: TODAY_0800 }), cron: morning.cron };
  const rig = sysRig([canonical]);
  try {
    const disabled = await cmdSystemDisable("morning-check-in", [morning], AFTER_0800);
    assert.equal(disabled.enabled, false);
    const disabledRecord = readStore(rig.store)[0]!;
    const beforeTrigger = JSON.stringify(disabledRecord);
    const id = await cmdSystemTrigger("morning-check-in", [morning], new Date("2026-08-20T19:00:00Z"), () => "deadbeef");
    assert.equal(id, "deadbeef");
    assert.equal(JSON.stringify(readStore(rig.store)[0]), beforeTrigger, "due-now trigger does not alter canonical range/queue bytes");
    const enabled = await cmdSystemEnable("morning-check-in", [morning], new Date("2026-08-20T19:00:00Z"));
    assert.equal(enabled.enabled, true);
    const selected = new Date(enabled.next_run_at!);
    const local = new Intl.DateTimeFormat("en-US", { timeZone: SYS_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(selected);
    assert.match(local, /^08:[0-5][0-9]$/);
    assert.ok(selected.getTime() > Date.parse("2026-08-20T19:00:00Z"));
    const trigger = readStore(rig.store).find((t) => t.id === "deadbeef")!;
    assert.equal(trigger.next_run_at, "2026-08-20T19:00:00.000Z", "trigger ignores noon/window policy");
  } finally { endSysRig(rig); }
});

test("system trigger atomically creates a due one-shot with only registry-backed metadata and leaves the disabled canonical record byte-for-byte unchanged", async () => {
  const canonical = canonicalDigest({
    system: { key: "test-daily-digest", enabled: false },
    next_run_at: "2026-08-22T15:00:00.000Z",
    invisible_until: "2026-08-20T20:00:00.000Z",
    attempts: 2,
  });
  const rig = sysRig([canonical]);
  try {
    const id = await cmdSystemTrigger("test-daily-digest", TEST_REGISTRY, AFTER_0800, () => "feedbeef");
    assert.equal(id, "feedbeef");
    const tasks = readStore(rig.store);
    assert.equal(tasks.length, 2);
    assert.deepEqual(tasks[0], canonical, "triggering never mutates canonical enabled/schedule/claim/retry state");
    // Check absence before deepEqual: assert's type predicate narrows tasks[1]
    // to the prompt-less expected literal, after which `.task` is not a known
    // property under strict TypeScript even though Task declares it optional.
    assert.equal(tasks[1].task, undefined, "no prompt or arbitrary executable identity is persisted");
    assert.deepEqual(tasks[1], {
      id: "feedbeef",
      desc: "Here’s what’s on the calendar",
      cron: null,
      at: AFTER_0800.toISOString(),
      tz: null,
      next_run_at: AFTER_0800.toISOString(),
      invisible_until: null,
      attempts: 0,
      deliver: null,
      system_trigger: { key: "test-daily-digest" },
      created_at: AFTER_0800.toISOString(),
    });
    assert.ok(!tasks[1].id.startsWith("system:"), "trigger uses the ordinary random-id namespace");
  } finally { endSysRig(rig); }
});

test("system trigger refuses unknown keys, minted-id collisions, and reserved namespace collisions without a write", async () => {
  const existing = sysOrdinary("feedbeef");
  const rig = sysRig([existing]);
  try {
    const before = readFileSync(rig.store, "utf8");
    await assert.rejects(cmdSystemTrigger("no-such-task", TEST_REGISTRY, AFTER_0800, () => "newid123"), /unknown system task key/);
    await assert.rejects(cmdSystemTrigger("test-daily-digest", TEST_REGISTRY, AFTER_0800, () => "feedbeef"), /id collision/);
    assert.equal(readFileSync(rig.store, "utf8"), before);
  } finally { endSysRig(rig); }

  const collisionRig = sysRig([sysOrdinary("system:other")]);
  try {
    const before = readFileSync(collisionRig.store, "utf8");
    await assert.rejects(cmdSystemTrigger("test-daily-digest", TEST_REGISTRY, AFTER_0800, () => "newid123"), ReservedIdCollisionError);
    assert.equal(readFileSync(collisionRig.store, "utf8"), before, "reserved-id fail-closed invariant remains intact");
  } finally { endSysRig(collisionRig); }
});

test("system triggers count toward HEARTBEAT_MAX_TASKS and are cancellable before claim", async () => {
  const rig = sysRig();
  try {
    const first = spawnScheduleCli(["system", "trigger", "morning-check-in"], { HEARTBEAT_MAX_TASKS: "1" });
    assert.equal(first.status, 0, first.stderr);
    const id = first.stdout.trim();
    assert.match(id, /^[0-9a-f]{8}$/, "the CLI prints a normal random task id");
    const [trigger] = readStore(rig.store);
    assert.equal(trigger.id, id);
    assert.deepEqual(trigger.system_trigger, { key: "morning-check-in" });

    const full = spawnScheduleCli(["system", "trigger", "morning-check-in"], { HEARTBEAT_MAX_TASKS: "1" });
    assert.equal(full.status, 1);
    assert.match(full.stderr, /schedule is full/);
    assert.equal(readStore(rig.store).length, 1);

    await cmdCancel(id, TEST_REGISTRY);
    assert.deepEqual(readStore(rig.store), [], "a trigger can be cancelled before heartbeat claims it");
  } finally { endSysRig(rig); }
});

test("the argv dispatcher wires the system subcommands (real registry) and rejects bad usage", () => {
  const rig = sysRig();
  try {
    const res = spawnScheduleCli(["system", "list"]);
    assert.equal(res.status, 0, res.stderr);
    const summaries = JSON.parse(res.stdout);
    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries.map((summary: { key: string }) => summary.key), ["morning-check-in"]);
    assert.ok(summaries.every((summary: { enabled: unknown }) => summary.enabled === true));
    assert.ok(summaries.every((summary: { enabled: unknown }) => typeof summary.enabled === "boolean"));
    // Active CLI identity is closed: retired names are not aliases for a
    // trigger (and therefore cannot create executable/cancellable queue work).
    // `system list` reconciles the fresh store first, so retain that canonical
    // baseline and prove each rejected command leaves it byte-for-byte alone.
    const beforeRetired = readFileSync(rig.store, "utf8");
    for (const retired of ["daily-calendar-digest", "friday-weekend-check-in", "monday-weekly-check-in"]) {
      const rejected = spawnScheduleCli(["system", "trigger", retired]);
      assert.equal(rejected.status, 1, retired);
      assert.match(rejected.stderr, /unknown system task key/);
      assert.equal(readFileSync(rig.store, "utf8"), beforeRetired, "a retired key must not create a trigger record");
    }
    const bad = spawnScheduleCli(["system"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /usage: schedule-cli system/);
    const missingTriggerKey = spawnScheduleCli(["system", "trigger"]);
    assert.equal(missingTriggerKey.status, 1);
    assert.match(missingTriggerKey.stderr, /system trigger <key>/);
  } finally { endSysRig(rig); }
});

test("ranged toggle preserves the policy and selected occurrence through a subsequent list", async () => {
  const morning: SystemTaskDefinition<string> = { key: "morning-check-in", desc: "Morning", cron: "0 8 * * *", window: { startHour: 8, minuteSlots: 60, cutoffHour: 12 }, execute: async () => ({ ok: true }) };
  const canonical = canonicalDigest({ id: "system:morning-check-in", desc: morning.desc, cron: morning.cron, next_run_at: "2026-08-21T15:00:00.000Z", system: { key: morning.key, enabled: false, policy: "v1:0 8 * * *:8:60:12" } });
  const rig = sysRig([canonical]);
  try {
    let selections = 0;
    const enabled = await cmdSystemEnable("morning-check-in", [morning], new Date("2026-08-20T19:00:00Z"), () => { selections++; return 17; });
    const afterEnable = readStore(rig.store)[0]!;
    assert.equal(selections, 1); assert.equal(afterEnable.system?.policy, "v1:0 8 * * *:8:60:12");
    await cmdSystemList([morning], new Date("2026-08-20T19:00:00Z"), () => { selections++; return 18; });
    assert.equal(selections, 1); assert.equal(JSON.stringify(readStore(rig.store)[0]), JSON.stringify(afterEnable));
    assert.equal(enabled.next_run_at, afterEnable.next_run_at);
  } finally { endSysRig(rig); }
});
