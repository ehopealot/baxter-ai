import { test } from "node:test";
import assert from "node:assert/strict";
import { enabledLightSurfaces, superviseSurface, main, type SupervisorDeps, type LightSurface } from "./light-bot.ts";
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
  assert.deepEqual(enabledLightSurfaces({ BAXTER_SURFACES: " mail , sms " } as NodeJS.ProcessEnv), ["sms"]);
  assert.deepEqual(enabledLightSurfaces({ BAXTER_SURFACES: "discord,mail,voice" } as NodeJS.ProcessEnv), []);
  assert.deepEqual(enabledLightSurfaces({} as NodeJS.ProcessEnv), []);
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

test("superviseSurface restarts even when main RETURNS (mains are infinite loops)", async () => {
  const waits: number[] = [];
  let calls = 0;
  const fakeMain = async () => { calls++; }; // returns immediately = bug in the surface
  const sleep = async (ms: number) => { waits.push(ms); if (waits.length === 2) throw new Error(ESCAPE); };
  await assert.rejects(
    superviseSurface("heartbeat", { mains: { heartbeat: fakeMain }, sleep, loggerForSurface: () => fakeLogger() }),
    (e: Error) => e.message === ESCAPE,
  );
  assert.equal(calls, 2);
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
