import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "./schedule-store.ts";
import { morningCheckInDefinition } from "./morning-check-in.ts";
import type { TickOptions } from "./heartbeat.ts";

async function freshHeartbeat() {
  const dir = mkdtempSync(join(tmpdir(), "morning-integration-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  const heartbeat = await import(`./heartbeat.ts?morning=${Date.now()}${Math.random()}`);
  const store = await import(`./schedule-store.ts?morning=${Date.now()}${Math.random()}`);
  return { dir, ...heartbeat, store };
}

test("heartbeat/store integration: empty Friday sends one fallback chain and advances the canonical occurrence", async () => {
  const { dir, tick, store } = await freshHeartbeat();
  const allow = join(dir, "allow.json");
  writeFileSync(allow, JSON.stringify({ version: 1, senders: [], recipients: ["a@example.test"], names: { "a@example.test": "Ari" } }));
  const delivered: string[] = [];
  const definition = morningCheckInDefinition({
    env: { BAXTER_TZ: "America/Los_Angeles" }, allowlistPath: allow,
    refreshImpl: async () => ({ urls: [], ok: true, events: [], errors: [], wroteCache: false, familySnapshot: [], retainedSnapshotAvailable: true }),
    readOwnEventsImpl: () => [],
    loadKnowledgeImpl: () => ({ text: "Ari likes short notes", empty: false, includedCollections: 0, omittedCollections: 0, truncatedSources: 0 }),
    runAgentImpl: async () => ({ failed: false, outOfTokens: false, resetsAt: null, resultText: JSON.stringify({ subject: "A warm Friday note", body: "Hope you have a lovely weekend. Let me know if I can help." }) }),
    sendSmsImpl: async () => { throw new Error("no phone"); },
    sendNewImpl: async (_to, _subject, body) => { delivered.push(body); },
  });
  const now = Date.parse("2026-08-21T16:00:00.000Z"); // Friday 09:00 PDT
  const canonical: Task = { id: "system:morning-check-in", desc: definition.desc, cron: definition.cron, at: null, tz: "America/Los_Angeles", next_run_at: "2026-08-21T15:00:00.000Z", invisible_until: null, attempts: 0, deliver: null, system: { key: "morning-check-in", enabled: true }, created_at: new Date(now).toISOString() };
  await store.mutate((tasks: Task[]) => ({ tasks: [canonical], value: null }));
  const opts: TickOptions = { runFn: async () => ({ ok: true }), reserveAgentRunFor: async () => ({ token: "reserved" }), releaseAgentRun: async () => {}, visibilityMs: 60_000, maxAttempts: 3, fallbackTz: "America/Los_Angeles", registry: [definition], systemHandlerResolver: (key) => key === definition.key ? definition.execute : undefined, log: () => {} };
  await tick(now, opts);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0]!, /Hope you have a lovely weekend/);
  const after = await store.readTasks();
  assert.equal(after.length, 1);
  assert.notEqual(after[0]!.next_run_at, canonical.next_run_at);
  const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(after[0]!.next_run_at));
  assert.match(local, /^08:[0-5][0-9]$/);
});
