import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "./schedule-store.ts";
import { makeFollowUpExecutor, type FollowUpQueueCommitter } from "./followup-execution.ts";
import type { FollowUpAuthority } from "./followup-types.ts";
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

test("generation is tool-less, content-suppressed, route-blind, and reserved immediately before run", async () => {
  const events: string[] = []; let options!: RunAgentOptions;
  const current = task();
  const executor = makeFollowUpExecutor({
    runAgent: async (input): Promise<RunAgentResult> => { options = input; events.push("run"); return { failed: false, outOfTokens: false, resetsAt: null, succeeded: true, resultText: "How is the store trip looking?", toolUseCount: 0 }; },
    authority: () => authority,
    sendSms: async () => { events.push("sms"); return {}; }, sendGroupSms: async () => ({}), sendReply: async () => {}, sendHomeChatEmail: async () => {}, resolveChatLink: () => "https://home.bax.bot/chats/wc-7",
  });
  const result = await executor(current, context(events), queue(current, events));
  assert.equal(result.ok, true);
  assert.equal(options.allowedTools, "");
  assert.equal(options.suppressContent, true);
  assert.equal(options.beforeRun, undefined);
  assert.deepEqual(events.slice(0, 2), ["reserve", "run"]);
  assert.match(options.prompt, /"subject":"store trip"/);
  for (const secret of [current.id, "+15551234567", "sms", "provider", "America/Los_Angeles"]) assert.equal(options.prompt.includes(secret), false);
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
      assert.deepEqual(calls[1], ["home", "member@example.com", "Checking back about store trip", "Still on for the store trip?\n\nhttps://home.bax.bot/chats/wc-7"]);
    } else assert.equal(calls.length, 1);
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
