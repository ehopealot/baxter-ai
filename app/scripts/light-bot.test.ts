import { test } from "node:test";
import assert from "node:assert/strict";
import { enabledLightSurfaces, superviseSurface, main, keepAliveTimer, drainForExit, type SupervisorDeps, type LightSurface } from "./light-bot.ts";
import { LightLifecycle } from "./light-lifecycle.ts";
import type { WorkerControlLifecycle } from "./worker-control.ts";
import type { SurfaceLogger } from "./runtime.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueAdmissionOutbox, admissionWorkId } from "./queue-admission-outbox.ts";

function fakeLogger(lines: string[] = []): SurfaceLogger {
  return { log: (m) => void lines.push(m), logErr: (m) => void lines.push(m) };
}
const ESCAPE = "__test_escape__";
const blockForever = () => new Promise<void>(() => {});

test("enabledLightSurfaces: parses, home encompasses chat, excludes heavy surfaces", () => {
  assert.deepEqual(enabledLightSurfaces({ BAXTER_SURFACES: "discord,heartbeat" } as NodeJS.ProcessEnv), ["heartbeat"]);
  assert.deepEqual(enabledLightSurfaces({ BAXTER_SURFACES: "home" } as NodeJS.ProcessEnv), ["home", "chat"]);
  assert.deepEqual(enabledLightSurfaces({ BAXTER_SURFACES: "chat" } as NodeJS.ProcessEnv), ["chat"]);
  assert.deepEqual(enabledLightSurfaces({ BAXTER_SURFACES: "mail" } as NodeJS.ProcessEnv), ["mail"]);
  assert.deepEqual(enabledLightSurfaces({ BAXTER_SURFACES: " mail , sms " } as NodeJS.ProcessEnv), ["mail", "sms"]);
  assert.deepEqual(enabledLightSurfaces({ BAXTER_SURFACES: "mail,sms,heartbeat,home" } as NodeJS.ProcessEnv), ["mail", "home", "heartbeat", "sms", "chat"]);
  assert.deepEqual(enabledLightSurfaces({ BAXTER_SURFACES: "discord,mail" } as NodeJS.ProcessEnv), ["mail"]);
  assert.deepEqual(enabledLightSurfaces({ BAXTER_SURFACES: "discord,mail,voice" } as NodeJS.ProcessEnv), ["mail"]);
  // Absent BAXTER_SURFACES -> the default fleet's light set (all five),
  // mirroring the Makefile's `?=` default at the runtime boundary (env_file is
  // the container's only source for the set, and the template ships it commented).
  assert.deepEqual(enabledLightSurfaces({} as NodeJS.ProcessEnv), ["mail", "home", "heartbeat", "sms", "chat"]);
  // An explicitly SET value naming no light surface is a deliberate off switch:
  // blank or non-light names start none (matches check-surfaces' convention).
  assert.deepEqual(enabledLightSurfaces({ BAXTER_SURFACES: "" } as NodeJS.ProcessEnv), []);
  assert.deepEqual(enabledLightSurfaces({ BAXTER_SURFACES: "discord" } as NodeJS.ProcessEnv), []);
});

test("superviseSurface restarts a crashing surface with capped backoff", async () => {
  const waits: number[] = [];
  let calls = 0;
  const fakeMain = async () => {
    calls++;
    if (calls <= 6) throw new Error(`boom ${calls}`);
    await blockForever();
  };
  const sleep = async (ms: number) => {
    waits.push(ms);
    if (waits.length === 6) throw new Error(ESCAPE); // test-only escape out of the infinite loop
  };
  await assert.rejects(
    superviseSurface("sms", { mains: { sms: fakeMain }, sleep, loggerForSurface: () => fakeLogger() }),
    (e: Error) => e.message === ESCAPE,
  );
  assert.deepEqual(waits, [1000, 2000, 5000, 15000, 60000, 60000]);
  assert.equal(calls, 6);
});

test("superviseSurface owns import and finite startup before main returns cleanly", async () => {
  const lifecycle = new LightLifecycle();
  let startupOwned = 0;
  await superviseSurface("home", {
    lifecycle,
    mains: { home: async () => {
      assert.equal(lifecycle.snapshot()["supervisor:home:import"], undefined);
      startupOwned = lifecycle.snapshot()["supervisor:home:startup"] ?? 0;
    } },
    loggerForSurface: () => fakeLogger(),
  });
  assert.equal(startupOwned, 1);
  assert.equal(lifecycle.idle, true);
});

test("superviseSurface stops (does NOT restart) when main returns cleanly", async () => {
  // home/sms/chat main() RETURN once they have wired their handlers and are resident
  // (link + fs.watch + ref'd keep-alive timer). A clean return is "started", not a
  // crash: supervision of that surface ends, with no restart and no backoff.
  const waits: number[] = [];
  let calls = 0;
  const fakeMain = async () => { calls++; };
  const sleep = async (ms: number) => { waits.push(ms); };
  // Resolves (does not reject or hang) -- the clean return terminates the loop.
  await superviseSurface("home", { mains: { home: fakeMain }, sleep, loggerForSurface: () => fakeLogger() });
  assert.equal(calls, 1);       // called once, never restarted
  assert.deepEqual(waits, []);  // never backed off
});

test("superviseSurface restarts on a startup throw, then stops once main returns cleanly", async () => {
  const waits: number[] = [];
  let calls = 0;
  // Two startup throws (retried with backoff), then a clean return that ends supervision.
  const fakeMain = async () => { calls++; if (calls <= 2) throw new Error(`boom ${calls}`); };
  const sleep = async (ms: number) => { waits.push(ms); };
  await superviseSurface("sms", { mains: { sms: fakeMain }, sleep, loggerForSurface: () => fakeLogger() });
  assert.equal(calls, 3);                 // crash, crash, clean start
  assert.deepEqual(waits, [1000, 2000]);  // backed off after each crash, then stopped
});

test("main supervises only enabled surfaces; one crashing does not stop the other", async () => {
  const old = process.env.BAXTER_SURFACES;
  process.env.BAXTER_SURFACES = "sms,chat";
  const started: string[] = [];
  let smsCalls = 0;
  const mains: SupervisorDeps["mains"] = {
    sms: async () => { smsCalls++; if (smsCalls <= 2) throw new Error("boom"); await blockForever(); },
    chat: async () => { started.push("chat"); await blockForever(); },
  };
  const sleep = async () => { if (smsCalls >= 2) throw new Error(ESCAPE); };
  await assert.rejects(
    main({ mains, sleep, loggerForSurface: () => fakeLogger() }),
    (e: Error) => e.message === ESCAPE,
  );
  assert.deepEqual(started, ["chat"]);
  assert.ok(smsCalls >= 2); // restarted after its first crash
  process.env.BAXTER_SURFACES = old;
});

test("main lifecycle-tracks hello before any surface startup", async () => {
  const old = process.env.BAXTER_SURFACES;
  process.env.BAXTER_SURFACES = "";
  const lifecycle = new LightLifecycle();
  let releaseHello!: () => void;
  const hello = new Promise<void>(resolve => { releaseHello = resolve; });
  const control: WorkerControlLifecycle = {
    hello: () => hello, renew: async () => {}, coverage: async () => {},
    drain: async () => {}, exitPermitted: async () => true,
  };
  try {
    const running = main({ lifecycle, workerControl: control, idle: async () => {}, loggerForSurface: () => fakeLogger() });
    await Promise.resolve();
    assert.equal(lifecycle.snapshot()["worker-control:hello"], 1);
    releaseHello();
    await running;
    assert.equal(lifecycle.snapshot()["worker-control:hello"], undefined);
  } finally { process.env.BAXTER_SURFACES = old; }
});

test("bounded drain reopens intake when the final worker-control exit check sees a wake", async () => {
  const lifecycle = new LightLifecycle();
  const calls: string[] = [];
  const control: WorkerControlLifecycle = {
    hello: async () => {}, renew: async () => {}, coverage: async () => {},
    drain: async () => { calls.push("drain"); },
    exitPermitted: async () => { calls.push("exit"); return false; },
  };
  assert.equal(await drainForExit(lifecycle, control, 1), false);
  assert.deepEqual(calls, ["drain", "exit"]);
  assert.equal(lifecycle.intakeClosed, false);
  assert.ok(lifecycle.admit("wake"));
});

test("SIGTERM deadline bounds a hung control drain and finalizes sources", async () => {
  const lifecycle = new LightLifecycle();
  let closed = 0;
  lifecycle.source("link", () => { closed++; }, () => {});
  const control: WorkerControlLifecycle = {
    hello: async () => {}, renew: async () => {}, coverage: async () => {},
    drain: async () => new Promise<void>(() => {}),
    exitPermitted: async () => { throw new Error("unreachable"); },
  };
  const started = Date.now();
  assert.equal(await drainForExit(lifecycle, control, 5), true);
  assert.ok(Date.now() - started < 250);
  assert.equal(closed, 1);
  assert.deepEqual(lifecycle.sourceSnapshot(), {});
});

test("keepAliveTimer returns a ref'd timer (holds the event loop open, unlike a bare pending promise)", () => {
  // The empty-set/all-returned idle depends on this: a never-resolving promise refs
  // nothing, so without a ref'd handle the container would exit 0 and flap.
  const t = keepAliveTimer();
  assert.equal(t.hasRef(), true);
  clearInterval(t); // don't leak the timer into the rest of the suite
});

test("main with absent BAXTER_SURFACES starts the default fleet's light set (all five)", async () => {
  // A template-derived .env (the line ships commented) through the runtime
  // boundary: with the var deleted, main() must reach every surface's main,
  // in LIGHT_SURFACE_NAMES order. The crash-throw + sleep escape proves each
  // main WAS started (an idling supervisor would never call them).
  const old = process.env.BAXTER_SURFACES;
  delete process.env.BAXTER_SURFACES;
  const started: string[] = [];
  const boom = (name: string) => async () => { started.push(name); throw new Error(ESCAPE); };
  const mains: SupervisorDeps["mains"] = {
    mail: boom("mail"), home: boom("home"), heartbeat: boom("heartbeat"),
    sms: boom("sms"), chat: boom("chat"),
  };
  const sleep = async () => { throw new Error(ESCAPE); };
  await assert.rejects(
    main({ mains, sleep, loggerForSurface: () => fakeLogger() }),
    (e: Error) => e.message === ESCAPE,
  );
  assert.deepEqual(started, ["mail", "home", "heartbeat", "sms", "chat"]);
  if (old === undefined) delete process.env.BAXTER_SURFACES; else process.env.BAXTER_SURFACES = old;
});

test("main starts replay-only surfaces for every retained queue, including pending non-agent effects, when disabled", async () => {
  const old = process.env.BAXTER_SURFACES;
  process.env.BAXTER_SURFACES = "";
  const dir = mkdtempSync(join(tmpdir(), "light-replay-only-"));
  const admissions = new QueueAdmissionOutbox(join(dir, "outbox.json"));
  const mailId = admissionWorkId("mail", 1, "tenant-replay");
  admissions.admit({ tenantId: "tenant-replay", queue: "mail", sequence: 1, workId: mailId, admittedAt: "t", variant: "agent-dispatch", input: {}, state: "pending", attempts: 0, nextAttemptAt: 0 });
  const smsId = admissionWorkId("sms", 2, "tenant-replay");
  admissions.admit({ tenantId: "tenant-replay", queue: "sms", sequence: 2, workId: smsId, admittedAt: "t", variant: "non-agent-terminal",
    outcomeType: "sms-stop", outcomeVersion: 1, outcome: { from: "+15551234567", content: "STOP" }, idempotencyKey: `sms-stop:${smsId}`, state: "pending-side-effects" });
  const chatId = admissionWorkId("chat", 3, "tenant-replay");
  admissions.admit({ tenantId: "tenant-replay", queue: "chat", sequence: 3, workId: chatId, admittedAt: "t", variant: "non-agent-terminal",
    outcomeType: "chat-create", outcomeVersion: 1, outcome: { kind: "create-chat" }, idempotencyKey: `chat-create:${chatId}`, state: "pending-side-effects" });
  admissions.completeNonAgent(chatId, { kind: "source-applied", surface: "chat", detail: "create-chat" });
  const started: Array<{ surface: string; replayOnly: boolean }> = [];
  const replayMain = (surface: string) => async (_logger: SurfaceLogger, _lifecycle: LightLifecycle, _progress: (n: number) => void, _admissions?: QueueAdmissionOutbox, replayOnly?: boolean) => {
    started.push({ surface, replayOnly: replayOnly === true });
  };
  try {
    await main({
      admissions,
      mains: { mail: replayMain("mail"), sms: replayMain("sms"), chat: replayMain("chat") },
      loggerForSurface: () => fakeLogger(), idle: async () => {},
    });
    assert.deepEqual(started, [
      { surface: "mail", replayOnly: true },
      { surface: "sms", replayOnly: true },
      { surface: "chat", replayOnly: true },
    ]);
  } finally {
    if (old === undefined) delete process.env.BAXTER_SURFACES; else process.env.BAXTER_SURFACES = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main with no enabled light surfaces logs once and idles (no mains started)", async () => {
  const old = process.env.BAXTER_SURFACES;
  process.env.BAXTER_SURFACES = "discord";
  const lines: string[] = [];
  let started = 0;
  await main({
    mains: { home: async () => { started++; }, heartbeat: async () => { started++; }, sms: async () => { started++; }, chat: async () => { started++; } },
    loggerForSurface: () => fakeLogger(lines),
    idle: async () => {},
  });
  assert.equal(started, 0);
  assert.ok(lines.some((l) => /no light surfaces/.test(l)));
  process.env.BAXTER_SURFACES = old;
});
