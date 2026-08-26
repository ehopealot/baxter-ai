import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cmdFollowUpAdd,
  cmdFollowUpCandidates,
  cmdFollowUpList,
} from "./followup-cli.ts";
import { createFollowUpRunContext, FOLLOW_UP_CONTEXT_ENV } from "./followup-context.ts";
import { currentFollowUpAuthority, type FollowUpAuthority } from "./followup-types.ts";

const allowAll: FollowUpAuthority = { directSms: () => true, groupSms: () => true, mailThread: () => true, homeChat: () => true };

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "followup-cli-"));
  const context = createFollowUpRunContext({ surface: "sms", conversation_id: "+15551234567", phone: "+15551234567" }, { dir: join(dir, "contexts") });
  const prior = process.env.SCHEDULE_DIR_OVERRIDE;
  process.env.SCHEDULE_DIR_OVERRIDE = join(dir, "schedule");
  const env = { BAXTER_TZ: "America/Los_Angeles", [FOLLOW_UP_CONTEXT_ENV]: context.path };
  return {
    dir, env,
    cleanup() {
      context.dispose();
      if (prior === undefined) delete process.env.SCHEDULE_DIR_OVERRIDE; else process.env.SCHEDULE_DIR_OVERRIDE = prior;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("add accepts only subject plus one plan-date flag and refuses routing/timezone syntax", async () => {
  const h = harness();
  try {
    const result = await cmdFollowUpAdd(["store trip", "--plan-date", "2026-08-28"], {
      env: h.env, authority: allowAll, now: new Date("2026-08-27T18:00:00.000Z"), selector: () => 0,
    });
    assert.deepEqual(Object.keys(result).sort(), ["id", "next_run_at", "plan_date", "subject"]);
    for (const flag of ["--tz", "--sms", "--sms-group", "--email", "--thread", "--chat", "--author", "--provider", "--delivery"] ) {
      await assert.rejects(() => cmdFollowUpAdd(["x", "--plan-date", "2026-08-29", flag, "bad"], { env: h.env, authority: allowAll, now: new Date("2026-08-27T18:00:00.000Z") }), /usage|unknown/);
    }
    await assert.rejects(() => cmdFollowUpAdd(["x", "--plan-date"], { env: h.env, authority: allowAll }), /usage/);
    await assert.rejects(() => cmdFollowUpAdd(["x", "--plan-date", "2026-08-29", "extra"], { env: h.env, authority: allowAll }), /usage/);
  } finally { h.cleanup(); }
});

test("add persists one code-owned origin, timing, metadata, exact dedup, and one add per turn", async () => {
  const h = harness();
  try {
    const deps = { env: h.env, authority: allowAll, now: new Date("2026-08-27T18:00:00.000Z"), selector: () => 179 };
    const added = await cmdFollowUpAdd(["  Ｓtore\u200b trip ", "--plan-date", "2026-08-28"], deps);
    assert.equal(added.subject, "Store trip");
    assert.equal(added.next_run_at, "2026-08-28T18:59:00.000Z");
    const records = JSON.parse(readFileSync(join(process.env.SCHEDULE_DIR_OVERRIDE!, "schedule.json"), "utf8"));
    assert.equal(records.length, 1);
    assert.equal(records[0].deliver, null);
    assert.deepEqual(records[0].follow_up.origin, { surface: "sms", id: "+15551234567" });
    assert.equal("subject_key" in records[0].follow_up, false);
    await assert.rejects(() => cmdFollowUpAdd(["Store trip", "--plan-date", "2026-08-28"], deps), /same turn|duplicate/);
    records[0].follow_up.turn_token = "b".repeat(64);
    writeFileSync(join(process.env.SCHEDULE_DIR_OVERRIDE!, "schedule.json"), JSON.stringify(records));
    await assert.rejects(() => cmdFollowUpAdd(["STORE TRIP", "--plan-date", "2026-08-28"], deps), /duplicate/);
    assert.equal(JSON.parse(readFileSync(join(process.env.SCHEDULE_DIR_OVERRIDE!, "schedule.json"), "utf8")).length, 1);
  } finally { h.cleanup(); }
});

test("list is private and candidates project nearby ordinary tasks", async () => {
  const h = harness();
  try {
    const deps = { env: h.env, authority: allowAll, now: new Date("2026-08-27T18:00:00.000Z"), selector: () => 0 };
    await cmdFollowUpAdd(["store trip", "--plan-date", "2026-08-28"], deps);
    const list = await cmdFollowUpList({ env: h.env });
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(), ["desc", "id", "next_run_at", "origin", "plan_date", "subject"]);
    assert.equal(JSON.stringify(list).includes("turn_token"), false);
    assert.equal(JSON.stringify(list).includes("+1555"), false);
    const candidates = await cmdFollowUpCandidates(["--plan-date", "2026-08-28"], { env: h.env, authority: allowAll });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].follow_up_subject, "store trip");
  } finally { h.cleanup(); }
});

test("missing capability or revoked current origin refuses before schedule creation", async () => {
  const h = harness();
  try {
    await assert.rejects(() => cmdFollowUpAdd(["x", "--plan-date", "2026-08-28"], { env: { BAXTER_TZ: "UTC" }, authority: allowAll }), /context path/);
    await assert.rejects(() => cmdFollowUpAdd(["x", "--plan-date", "2026-08-28"], {
      env: h.env, authority: { ...allowAll, directSms: () => false }, now: new Date("2026-08-27T18:00:00.000Z"),
    }), /not currently authorized/);
  } finally { h.cleanup(); }
});

test("corrupt durable authority refuses creation even when the initial env seed is broader", async () => {
  const h = harness();
  try {
    const allowlistPath = join(h.dir, "allowlist.json");
    writeFileSync(allowlistPath, "{");
    const env = { ...h.env, ALLOWED_SENDERS: "+15551234567" };
    await assert.rejects(() => cmdFollowUpAdd(["store", "--plan-date", "2026-08-28"], {
      env, authority: currentFollowUpAuthority(env, allowlistPath), now: new Date("2026-08-27T18:00:00.000Z"), selector: () => 0,
    }), /not currently authorized/);
    assert.equal(existsSync(join(process.env.SCHEDULE_DIR_OVERRIDE!, "schedule.json")), false, "refusal occurs before schedule mutation");
  } finally { h.cleanup(); }
});
