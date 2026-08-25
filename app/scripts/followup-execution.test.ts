import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "./schedule-store.ts";
import { makeFollowUpExecutor, type FollowUpQueueCommitter } from "./followup-execution.ts";
import { cancelWithFollowUpLinearization } from "./followup-delivery-lock.ts";
import { currentFollowUpAuthority, type FollowUpAuthority } from "./followup-types.ts";
import type { RunAgentOptions, RunAgentResult } from "./runtime.ts";

const authority: FollowUpAuthority = { directSms: () => true, groupSms: () => true, mailThread: () => true, homeChat: () => true };

function task(route: "sms" | "sms-group" | "mail" | "home" = "sms"): Task {
  const base: Task = {
    id: `id-${route}`, task: "proactive-follow-up:v1", desc: "Check back about store trip", cron: null,
    at: "2026-08-28T16:00:00.000Z", tz: "America/Los_Angeles", next_run_at: "2026-08-28T16:00:00.000Z",
    invisible_until: "2026-08-28T16:15:00.000Z", attempts: 0, created_at: "2026-08-27T18:00:00.000Z",
    deliver: { surface: "sms", target: "+15551234567" },
    follow_up: { version: 1, subject: "store trip", subject_key: "store trip", plan_date: "2026-08-28", turn_token: "a".repeat(64), origin: { surface: "sms", id: "+15551234567" } },
  };
  if (route === "sms-group") return { ...base, id: "id-group", deliver: { surface: "sms-group", target: "grp_family" }, follow_up: { ...base.follow_up!, origin: { surface: "sms-group", id: "grp_family" } } };
  if (route === "mail") return { ...base, id: "id-mail", deliver: { surface: "mail-thread", target: "resend:member@example.com:abc" }, follow_up: { ...base.follow_up!, origin: { surface: "mail-thread", id: "resend:member@example.com:abc" } } };
  if (route === "home") return { ...base, id: "id-home", deliver: { surface: "home-chat-email", target: "member@example.com", chat_id: "wc-7" }, follow_up: { ...base.follow_up!, origin: { surface: "home-chat", id: "wc-7", email: "member@example.com" } } };
  return base;
}

function queue(current: Task | null, events: string[]): FollowUpQueueCommitter {
  return {
    reload: async () => current,
    success: async () => { events.push("success"); },
    failure: async () => { events.push("failure"); return { gaveUp: false }; },
  };
}

function context(events: string[]) {
  return {
    reserveAgentRun: async () => { events.push("reserve"); return { token: "slot" }; },
    releaseAgentRun: async () => { events.push("release"); },
  };
}

async function withDeliveryDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "followup-execution-lock-"));
  const old = process.env.FOLLOW_UP_DELIVERY_LOCK_DIR_OVERRIDE;
  process.env.FOLLOW_UP_DELIVERY_LOCK_DIR_OVERRIDE = dir;
  try { await run(dir); }
  finally {
    if (old === undefined) delete process.env.FOLLOW_UP_DELIVERY_LOCK_DIR_OVERRIDE; else process.env.FOLLOW_UP_DELIVERY_LOCK_DIR_OVERRIDE = old;
    rmSync(dir, { recursive: true, force: true });
  }
}

function waiterPath(dir: string, taskId: string, suffix: string): string {
  const key = createHash("sha256").update(taskId).digest("hex");
  return join(dir, `${key}.waiter.${suffix}.json`);
}

test("generation is tool-less in a fresh credential-free cwd that is removed after the run", async () => {
  const events: string[] = []; let options!: RunAgentOptions; let cwdDuringRun = "";
  const current = task();
  const oldSecret = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "must-not-enter-generation";
  const executor = makeFollowUpExecutor({
    runAgent: async (input): Promise<RunAgentResult> => {
      options = input; cwdDuringRun = input.cwd; events.push("run");
      assert.equal(existsSync(input.cwd), true, "fresh cwd exists only while generation runs");
      for (const relative of [join(".claude", "skills"), "memory.md", "CREDENTIALS.md", "learned-skills"]) {
        assert.equal(existsSync(join(input.cwd, relative)), false, `${relative} is absent from generation cwd`);
      }
      assert.equal(input.env?.RESEND_API_KEY, undefined, "generation options contain no provider secret");
      return { failed: false, outOfTokens: false, resetsAt: null, succeeded: true, resultText: "How is the store trip looking?", toolUseCount: 0 };
    },
    authority: () => authority,
    sendSms: async () => { events.push("sms"); return {}; }, sendGroupSms: async () => ({}), sendReply: async () => {}, sendHomeChatEmail: async () => {}, resolveChatLink: () => "https://home.bax.bot/chats/wc-7",
  });
  try {
    const result = await executor(current, context(events), queue(current, events));
    assert.equal(result.ok, true);
    assert.equal(options.allowedTools, "");
    assert.equal(options.suppressContent, true);
    assert.equal(options.beforeRun, undefined);
    assert.deepEqual(events.slice(0, 2), ["reserve", "run"]);
    assert.match(options.prompt, /"subject":"store trip"/);
    for (const secret of [current.id, "+15551234567", "sms", "provider", "America/Los_Angeles"]) assert.equal(options.prompt.includes(secret), false);
    assert.equal(existsSync(cwdDuringRun), false, "fresh generation cwd is removed in finally");
  } finally {
    if (oldSecret === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = oldSecret;
  }
});

test("invalid, tool-attempting, empty, and oversized generation makes zero provider calls", async () => {
  for (const generated of [
    { succeeded: true, resultText: "", toolUseCount: 0 },
    { succeeded: true, resultText: "hello", toolUseCount: 1 },
    { succeeded: true, resultText: "😀".repeat(1001), toolUseCount: 0 },
    { succeeded: false, resultText: "hello", toolUseCount: 0 },
  ]) {
    let providers = 0; const events: string[] = []; const current = task();
    const executor = makeFollowUpExecutor({
      runAgent: async () => ({ failed: false, outOfTokens: false, resetsAt: null, ...generated }), authority: () => authority,
      sendSms: async () => { providers++; return {}; }, sendGroupSms: async () => { providers++; return {}; }, sendReply: async () => { providers++; }, sendHomeChatEmail: async () => { providers++; }, resolveChatLink: () => "x",
    });
    assert.equal((await executor(current, context(events), queue(current, events))).ok, false);
    assert.equal(providers, 0);
  }
});

test("each valid persisted route invokes exactly one code-owned provider and Home appends the exact link", async () => {
  for (const route of ["sms", "sms-group", "mail", "home"] as const) {
    const calls: unknown[][] = []; const events: string[] = []; const current = task(route);
    const executor = makeFollowUpExecutor({
      runAgent: async () => ({ failed: false, outOfTokens: false, resetsAt: null, succeeded: true, resultText: "Still on for the store trip?", toolUseCount: 0 }), authority: () => authority,
      sendSms: async (...args) => { calls.push(["sms", ...args]); return {}; },
      sendGroupSms: async (...args) => { calls.push(["group", ...args]); return {}; },
      sendReply: async (...args) => { calls.push(["mail", ...args]); },
      sendHomeChatEmail: async (...args) => { calls.push(["home", ...args]); },
      resolveChatLink: (id) => { calls.push(["link", id]); return `https://home.bax.bot/chats/${id}`; },
    });
    const result = await executor(current, context(events), queue(current, events));
    assert.equal(result.ok, true);
    if (route === "home") {
      assert.deepEqual(calls[0], ["link", "wc-7"]);
      assert.deepEqual(calls[1].slice(0, 4), ["home", "member@example.com", "Checking back about store trip", "Still on for the store trip?\n\nhttps://home.bax.bot/chats/wc-7"]);
      assert.ok((calls[1][4] as { signal?: AbortSignal }).signal instanceof AbortSignal);
    } else {
      assert.equal(calls.length, 1);
      assert.ok((calls[0].at(-1) as { signal?: AbortSignal }).signal instanceof AbortSignal, `${route} receives an abort signal`);
    }
  }
});

test("revoked authority or immutable reload change refuses before provider and commits failure under lock", async () => {
  for (const scenario of [
    { current: task(), currentAuthority: { ...authority, directSms: () => false } },
    { current: { ...task(), deliver: { surface: "sms", target: "+15550000000" } } as Task, currentAuthority: authority },
  ]) {
    let providers = 0; const events: string[] = []; let authorityCalls = 0;
    const executor = makeFollowUpExecutor({
      runAgent: async () => ({ failed: false, outOfTokens: false, resetsAt: null, succeeded: true, resultText: "Hello", toolUseCount: 0 }),
      authority: () => (++authorityCalls === 1 ? authority : scenario.currentAuthority),
      sendSms: async () => { providers++; return {}; }, sendGroupSms: async () => ({}), sendReply: async () => {}, sendHomeChatEmail: async () => {}, resolveChatLink: () => "x",
    });
    const result = await executor(task(), context(events), queue(scenario.current, events));
    assert.equal(result.ok, false);
    assert.equal(providers, 0);
  }
});

test("corrupt durable authority refuses execution before generation or provider despite a broader env seed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "followup-execution-authority-"));
  const allowlistPath = join(dir, "allowlist.json"); writeFileSync(allowlistPath, "{");
  let generations = 0, providers = 0; const events: string[] = [];
  const executor = makeFollowUpExecutor({
    runAgent: async () => { generations++; return { failed: false, outOfTokens: false, resetsAt: null }; },
    authority: () => currentFollowUpAuthority({ ALLOWED_SENDERS: "+15551234567" }, allowlistPath),
    sendSms: async () => { providers++; return {}; }, sendGroupSms: async () => ({}), sendReply: async () => {}, sendHomeChatEmail: async () => {}, resolveChatLink: () => "x",
  });
  try {
    const result = await executor(task(), context(events), queue(task(), events));
    assert.equal(result.ok, false);
    assert.equal(generations, 0);
    assert.equal(providers, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provider timeout aborts and settles work before queue failure and lock release", async () => withDeliveryDir(async () => {
  const events: string[] = []; const current = task();
  let providerSignal: AbortSignal | undefined; let providerSettled = false;
  const executor = makeFollowUpExecutor({
    runAgent: async () => ({ failed: false, outOfTokens: false, resetsAt: null, succeeded: true, resultText: "Hello", toolUseCount: 0 }),
    authority: () => authority,
    sendSms: async (_phone, _body, deps) => new Promise((_resolve, reject) => {
      providerSignal = deps?.signal;
      providerSignal?.addEventListener("abort", () => { providerSettled = true; reject(providerSignal?.reason); }, { once: true });
      setTimeout(() => { if (!providerSettled) { providerSettled = true; reject(new Error("test safety timeout")); } }, 20);
    }),
    sendGroupSms: async () => ({}), sendReply: async () => {}, sendHomeChatEmail: async () => {}, resolveChatLink: () => "x",
    providerTimeoutMs: 1,
  });
  const committedQueue: FollowUpQueueCommitter = {
    reload: async () => current,
    success: async () => { assert.fail("timed-out provider cannot succeed"); },
    failure: async () => { assert.equal(providerSettled, true, "provider settled before queue mutation"); events.push("failure"); return { gaveUp: false }; },
  };
  const result = await executor(current, context(events), committedQueue);
  assert.equal(providerSignal?.aborted, true);
  assert.equal(result.queueCommitted, "failed");
  assert.deepEqual(events.filter((event) => event === "failure"), ["failure"]);
}));

test("send-first cancellation waits through the provider timeout, reports send_already_started, and cleans its waiter", async () => withDeliveryDir(async (dir) => {
  const current = task(); let providerEntered!: () => void;
  const entered = new Promise<void>((resolve) => { providerEntered = resolve; });
  const events: string[] = [];
  const executor = makeFollowUpExecutor({
    runAgent: async () => ({ failed: false, outOfTokens: false, resetsAt: null, succeeded: true, resultText: "Hello", toolUseCount: 0 }), authority: () => authority,
    sendSms: async (_phone, _body, deps) => new Promise((_resolve, reject) => {
      providerEntered();
      deps?.signal?.addEventListener("abort", () => reject(deps.signal?.reason), { once: true });
    }),
    sendGroupSms: async () => ({}), sendReply: async () => {}, sendHomeChatEmail: async () => {}, resolveChatLink: () => "x", providerTimeoutMs: 15,
  });
  const execution = executor(current, context(events), queue(current, events));
  await entered;
  let cancelSettled = false;
  const cancellation = cancelWithFollowUpLinearization(current.id, async () => true).then((value) => { cancelSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelSettled, false, "cancellation remains registered while provider owns delivery");
  assert.equal((await execution).queueCommitted, "failed");
  assert.deepEqual(await cancellation, { removed: true, status: "send_already_started" });
  assert.equal(readdirSync(dir).some((name) => name.includes(".waiter.")), false);
}));

test("malformed and crash-orphan waiters are quarantined before successful or failed provider work, preserving one committed outcome", async () => {
  for (const providerOk of [true, false]) await withDeliveryDir(async (dir) => {
    const current = task();
    mkdirSync(dir, { recursive: true });
    writeFileSync(waiterPath(dir, current.id, providerOk ? "truncated" : "crash"), providerOk
      ? "{\"version\":"
      : JSON.stringify({ version: 1, created_at: 0, status: "pending" }), { mode: 0o600 });
    const events: string[] = [];
    const executor = makeFollowUpExecutor({
      runAgent: async () => ({ failed: false, outOfTokens: false, resetsAt: null, succeeded: true, resultText: "Hello", toolUseCount: 0 }),
      authority: () => authority,
      sendSms: async () => { events.push("provider"); if (!providerOk) throw new Error("provider failed"); return {}; },
      sendGroupSms: async () => ({}), sendReply: async () => {}, sendHomeChatEmail: async () => {}, resolveChatLink: () => "x",
    });
    const result = await executor(current, context(events), queue(current, events));
    assert.equal(result.queueCommitted, providerOk ? "completed" : "failed");
    assert.equal(events.filter((event) => event === "success" || event === "failure").length, 1, "exactly one queue mutation");
    assert.equal(readdirSync(dir).some((name) => name.includes(".waiter.")), false, "bad waiter is removed or quarantined out of the active namespace");
  });
});
