import { test } from "node:test";
import assert from "node:assert/strict";
import { LightLifecycle } from "./light-lifecycle.ts";

type Boundary = { name: string; clock: "immediate" | "timer" };

// The finite inventory in docs/plans/2026-08-27-tenant-hibernation.md. Keeping
// every plan row source-named makes omissions reviewable instead of hiding them
// behind one generic "work" counter assertion.
const FINITE_LIFECYCLE: Boundary[] = [
  { name: "supervisor:module-import", clock: "immediate" },
  { name: "supervisor:start-retry", clock: "timer" },
  { name: "supervisor:backoff-sleep", clock: "timer" },
  { name: "supervisor:surface-startup", clock: "immediate" },

  { name: "mail:link-callback", clock: "immediate" },
  { name: "mail:serial-receive-chain", clock: "immediate" },
  ...["classify", "append", "file-fsync", "parent-fsync", "replay", "terminal-state", "compaction"].map(name => ({ name: `mail:outbox-${name}`, clock: "immediate" as const })),
  ...["debounce", "queued", "waiting-global-slot"].map(name => ({ name: `mail:dispatcher-${name}`, clock: "timer" as const })),
  { name: "mail:dispatcher-active-run", clock: "immediate" },
  { name: "mail:non-agent-side-effect", clock: "immediate" },
  ...["cursor-write", "dlq-write", "ack-write"].map(name => ({ name: `mail:${name}`, clock: "immediate" as const })),

  { name: "sms:link-callback", clock: "immediate" },
  { name: "sms:serial-receive-chain", clock: "immediate" },
  ...["classify", "append", "file-fsync", "parent-fsync", "replay", "terminal-state", "compaction"].map(name => ({ name: `sms:outbox-${name}`, clock: "immediate" as const })),
  { name: "sms:stop-opt-out-completion", clock: "immediate" },
  ...["debounce", "queued", "waiting"].map(name => ({ name: `sms:dispatcher-${name}`, clock: "timer" as const })),
  { name: "sms:dispatcher-active-run", clock: "immediate" },
  ...["cursor-write", "dlq-write", "ack-write"].map(name => ({ name: `sms:${name}`, clock: "immediate" as const })),

  { name: "chat:link-intent-chain", clock: "immediate" },
  ...["classify", "append", "file-fsync", "parent-fsync", "replay", "terminal-state", "compaction"].map(name => ({ name: `chat:outbox-${name}`, clock: "immediate" as const })),
  ...["debounce", "queued", "waiting"].map(name => ({ name: `chat:dispatcher-${name}`, clock: "timer" as const })),
  { name: "chat:dispatcher-active-run", clock: "immediate" },
  { name: "chat:non-agent-side-effect", clock: "immediate" },
  ...["cursor-write", "dlq-write", "ack-write", "pre-turn-done-write"].map(name => ({ name: `chat:${name}`, clock: "immediate" as const })),
  { name: "chat:watch-debounce", clock: "timer" },
  { name: "chat:watch-changed-send", clock: "immediate" },
  ...["admission", "model-renewal", "provider-fetch", "index-write", "changed-send"].map(name => ({ name: `chat:auto-title-${name}`, clock: "immediate" as const })),

  ...["checklist", "chat", "recipe", "calendar", "schedule"].flatMap(surface => [
    { name: `home:${surface}-link-callback`, clock: "immediate" as const },
    { name: `home:${surface}-apply`, clock: "immediate" as const },
    { name: `home:${surface}-watch-debounce`, clock: "timer" as const },
    { name: `home:${surface}-changed-send`, clock: "immediate" as const },
  ]),

  { name: "collections:startup-reconciliation", clock: "immediate" },
  { name: "collections:source-watch-callback", clock: "immediate" },
  { name: "collections:per-slug-debounce", clock: "timer" },
  { name: "collections:serial-queue-entry", clock: "immediate" },
  { name: "collections:retry-timer", clock: "timer" },
  { name: "collections:active-model-render", clock: "immediate" },
  { name: "collections:generation-fenced-publish-remove", clock: "immediate" },
  { name: "collections:on-change", clock: "immediate" },
  { name: "collections:periodic-reconciliation", clock: "timer" },

  { name: "calendar:automatic-poll-timer", clock: "timer" },
  { name: "calendar:explicit-command-poll", clock: "immediate" },
  { name: "calendar:morning-check-in-poll", clock: "immediate" },
  ...["wait", "renew", "release"].map(name => ({ name: `calendar:refresh-lock-${name}`, clock: "immediate" as const })),
  { name: "calendar:feed-fetch", clock: "immediate" },
  { name: "calendar:feed-timeout", clock: "timer" },
  { name: "calendar:feed-parse", clock: "immediate" },
  ...["file-fsync", "rename", "parent-fsync"].map(name => ({ name: `calendar:cache-${name}`, clock: "immediate" as const })),
  { name: "calendar:changed-send", clock: "immediate" },

  { name: "heartbeat:tick", clock: "timer" },
  { name: "heartbeat:claimed-task", clock: "immediate" },
  { name: "heartbeat:quota-reservation", clock: "immediate" },
  { name: "heartbeat:active-agent-handler", clock: "immediate" },
  { name: "heartbeat:active-system-handler", clock: "immediate" },
  { name: "heartbeat:calendar-refresh", clock: "immediate" },
  { name: "heartbeat:provider-delivery", clock: "immediate" },
  { name: "heartbeat:schedule-retry-finalization", clock: "timer" },
  { name: "heartbeat:wake-hint-write", clock: "immediate" },

  { name: "worker-control:request", clock: "immediate" },
  { name: "worker-control:provider-permit", clock: "immediate" },
  { name: "worker-control:provider-renewal", clock: "immediate" },
  { name: "worker-control:lease-renewal-timer", clock: "timer" },
  { name: "worker-control:in-flight-abort-late-discard", clock: "immediate" },
  { name: "worker-control:coverage-write", clock: "immediate" },
  { name: "worker-control:coverage-send", clock: "immediate" },
  { name: "worker-control:coverage-replay", clock: "immediate" },
  { name: "worker-control:final-exit-check", clock: "immediate" },
];

class FakeClock {
  #next = 0;
  #timers = new Map<number, () => void>();
  setTimeout(callback: () => void): number { const id = ++this.#next; this.#timers.set(id, callback); return id; }
  clearTimeout(id: number): void { this.#timers.delete(id); }
  tick(): void { const timers = [...this.#timers.values()]; this.#timers.clear(); for (const callback of timers) callback(); }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}

test("the exhaustive plan-required finite lifecycle inventory stays non-idle across fake-clock and blocked-promise boundaries", async t => {
  assert.equal(new Set(FINITE_LIFECYCLE.map(row => row.name)).size, FINITE_LIFECYCLE.length, "inventory names are unique and source-discoverable");
  for (const row of FINITE_LIFECYCLE) await t.test(row.name, async () => {
    const lifecycle = new LightLifecycle();
    const clock = new FakeClock();
    const blocked = deferred();
    let task: Promise<void> | undefined;
    const begin = () => {
      const release = lifecycle.admit(row.name);
      assert.ok(release, `${row.name} is admitted before the close fence`);
      task = blocked.promise.finally(release!);
    };
    if (row.clock === "timer") {
      const timer = clock.setTimeout(begin);
      lifecycle.source(`${row.name}:intake-timer`, () => clock.clearTimeout(timer));
      clock.tick();
    } else begin();

    assert.equal(lifecycle.idle, false, `${row.name} blocks idle while its direct boundary is unresolved`);
    lifecycle.closeIntake();
    assert.equal(lifecycle.admit(`${row.name}:after-fence`), null, "new work after the fence is refused");
    let drained = false;
    const draining = lifecycle.drain().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false, `${row.name} remains owned after intake closes`);
    blocked.resolve();
    await task;
    await draining;
    assert.equal(lifecycle.idle, true);
  });
});
