import { test } from "node:test";
import assert from "node:assert/strict";
import { enabledLightSurfaces, superviseSurface, main, keepAliveTimer, type SupervisorDeps, type LightSurface } from "./light-bot.ts";
import type { SurfaceLogger } from "./runtime.ts";

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
