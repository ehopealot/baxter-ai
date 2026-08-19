import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Task } from "./schedule-store.ts";
import { buildTaskPrompt } from "./heartbeat.ts";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

async function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  return import(`./heartbeat.ts?t=${Date.now()}${Math.random()}`);
}

test("tick fires a due one-shot, removes it on success, logs completed", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.ts?t=${Date.now()}a`);
  await store.mutate((t: Task[]) => ({ tasks: [{ id: "o", task: "x", at: "2026-01-01T00:00:00Z", cron: null, tz: null, deliver: null, next_run_at: "2026-01-01T00:00:00Z", invisible_until: null, attempts: 0 }], value: null }));
  const fired: string[] = [];
  await tick(Date.parse("2026-01-02T00:00:00Z"), { runFn: async (task: Task) => { fired.push(task.id); return { ok: true }; }, fireCap: 100, visibilityMs: 900000, maxAttempts: 3, fallbackTz: "UTC" });
  assert.deepEqual(fired, ["o"]);
  assert.equal((await store.readTasks()).length, 0);
});

test("tick does NOT fire when the cap is exhausted, and logs skipped once/day", async () => {
  // Use real 'now' so the store's today() (real clock) matches the logged ts;
  // a past next_run_at keeps the task due. Two ticks, still capped.
  const { tick } = await freshStore();
  const dir = process.env.SCHEDULE_DIR_OVERRIDE as string;
  const store = await import(`./schedule-store.ts?t=${Date.now()}b`);
  const now = Date.now();
  for (let i = 0; i < 3; i++) store.appendLog({ ts: new Date(now).toISOString(), id: `x${i}`, outcome: "completed" });
  await store.mutate((t: Task[]) => ({ tasks: [{ id: "d", task: "x", at: "2000-01-01T00:00:00Z", cron: null, next_run_at: "2000-01-01T00:00:00Z", invisible_until: null, attempts: 0 }], value: null }));
  let fired = 0;
  const opts = { runFn: async () => { fired++; return { ok: true }; }, fireCap: 3, visibilityMs: 900000, maxAttempts: 3, fallbackTz: "UTC" };
  await tick(now, opts);
  await tick(now + 60000, opts); // next tick, still capped -> must NOT re-log skipped
  assert.equal(fired, 0);
  const { readFileSync } = await import("node:fs");
  const skipped = readFileSync(join(dir, "task-log.jsonl"), "utf8").split("\n").filter((l) => l.includes('"skipped"')).length;
  assert.equal(skipped, 1); // once per day, not once per tick
});

test("tick: a hard failure hits the retry path (attempts++), not success", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.ts?t=${Date.now()}f`);
  await store.mutate((t: Task[]) => ({ tasks: [{ id: "c", task: "x", cron: "0 * * * *", at: null, tz: null, deliver: null, next_run_at: "2000-01-01T00:00:00Z", invisible_until: null, attempts: 0 }], value: null }));
  await tick(Date.now(), { runFn: async () => ({ ok: false }), fireCap: 100, visibilityMs: 900000, maxAttempts: 3, fallbackTz: "UTC" });
  const t = (await store.readTasks())[0];
  assert.equal(t.attempts, 1); // failure reached applyOnFailure (not silently completed)
  assert.ok(t.cron);           // cron task still present, not rescheduled/removed
});

test("tick: out-of-tokens leaves the claim, burns no attempt, stops the tick", async () => {
  const { tick } = await freshStore();
  const store = await import(`./schedule-store.ts?t=${Date.now()}g`);
  await store.mutate((t: Task[]) => ({ tasks: [
    { id: "a", task: "x", at: "2000-01-01T00:00:00Z", cron: null, tz: null, deliver: null, next_run_at: "2000-01-01T00:00:00Z", invisible_until: null, attempts: 0 },
    { id: "b", task: "y", at: "2000-01-01T00:00:00Z", cron: null, tz: null, deliver: null, next_run_at: "2000-01-01T00:00:00Z", invisible_until: null, attempts: 0 },
  ], value: null }));
  let fired = 0;
  await tick(Date.now(), { runFn: async () => { fired++; return { ok: false, outOfTokens: true }; }, fireCap: 100, visibilityMs: 900000, maxAttempts: 3, fallbackTz: "UTC" });
  assert.equal(fired, 1); // broke after the first; didn't march through b
  const tasks = await store.readTasks();
  assert.equal(tasks.length, 2); // both still present
  const a = tasks.find((t: Task) => t.id === "a");
  assert.equal(a.attempts, 0);   // no attempt burned
  assert.ok(a.invisible_until);  // claim left -> retries free after the window
});

test("buildTaskPrompt renders the household section immediately before collections", () => {
  const task: Task = { id: "t", task: "x", at: "2026-01-01T00:00:00Z", cron: null, tz: null, deliver: null, next_run_at: "2026-01-01T00:00:00Z", invisible_until: null, attempts: 0 };
  const prompt = buildTaskPrompt(task);
  assert.match(prompt, /## Your household/);
  assert.match(prompt, /The people in this household, and how to reach them:/);
  // Identical in both URL variants of the guidance, so it holds on any box.
  assert.match(prompt, /you can text any phone number listed for the household/);
  // no filled-prompt brace scan (false-failure trap): household names from ambient env keep
  // {{...}} byte-intact under the single-pass fill. The positive matches above already prove
  // the fill happened (the placement pin can only render from a real preamble), so pin the
  // template side instead: the raw template carries the placeholder.
  assert.ok(readFileSync(join(APP_DIR, "heartbeat-prompt.md"), "utf8").includes("{{HOUSEHOLD}}"));
  // The guidance tail ends the household block in both URL variants, so this
  // proves the section renders immediately before the collections section
  // (catches misplacement, not just presence).
  assert.match(prompt, /can't be texted\.\n\n## Your collections/);
});

test("buildTaskPrompt distinguishes an sms-group destination from a 1:1 sms one, with the send-group verb and the operator fallback (scheduled-sms-group spec test 7)", () => {
  // An sms-group task renders its own DELIVER line and its own delivery bullet.
  const groupTask: Task = { id: "g", task: "digest the group", at: "2026-01-01T00:00:00Z", cron: null, tz: null, deliver: { surface: "sms-group", target: "grp_abc" }, next_run_at: "2026-01-01T00:00:00Z", invisible_until: null, attempts: 0 };
  const prompt = buildTaskPrompt(groupTask);
  assert.match(prompt, /\*\*sms-group -> grp_abc\*\*/, "the DELIVER line names the surface and the exact group id");
  assert.match(prompt, /sms-cli send-group <groupId>/, "the group bullet gives the send-group verb");
  assert.match(prompt, /never claim the group delivery succeeded/, "a refused/failed group send escalates instead of silently succeeding");
  assert.match(prompt, /naming the intended group/, "the fallback names the intended group for the operator");
  // A 1:1 sms task keeps its own verb -- the two cannot drift into one another.
  const smsTask: Task = { id: "s", task: "text them", at: "2026-01-01T00:00:00Z", cron: null, tz: null, deliver: { surface: "sms", target: "+15551234567" }, next_run_at: "2026-01-01T00:00:00Z", invisible_until: null, attempts: 0 };
  const smsPrompt = buildTaskPrompt(smsTask);
  assert.match(smsPrompt, /\*\*sms -> \+15551234567\*\*/);
  assert.match(smsPrompt, /sms-cli send <phone>/, "the 1:1 bullet keeps the plain send verb");
});
