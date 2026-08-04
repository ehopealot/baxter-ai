// core/app/scripts/sms-cli.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendSms } from "./sms-cli.ts";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "sms-cli-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  process.env.SEND_STATE_DIR_OVERRIDE = dir;
  process.env.SENDBLUE_API_KEY = "k"; process.env.SENDBLUE_API_SECRET = "s"; process.env.SENDBLUE_FROM_NUMBER = "+15559999999";
  return { dir };
}
const cleanup = (dir: string) => { for (const v of ["SMS_TRANSCRIPT_DIR_OVERRIDE","SEND_STATE_DIR_OVERRIDE","SENDBLUE_API_KEY","SENDBLUE_API_SECRET","SENDBLUE_FROM_NUMBER"]) delete process.env[v]; rmSync(dir, { recursive: true, force: true }); };

test("sendSms posts to Sendblue with auth headers and appends the outbound transcript", async () => {
  const { dir } = harness();
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await sendSms("+15551234567", "hello there", { fetchImpl: fakeFetch });
    assert.match(calls[0].url, /\/api\/send-message$/);
    assert.equal(calls[0].init.headers["sb-api-key-id"], "k");
    assert.equal(calls[0].init.headers["sb-api-secret-key"], "s");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.number, "+15551234567");
    assert.equal(body.from_number, "+15559999999");
    assert.equal(body.content, "hello there");
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("+15551234567").at(-1)!.direction, "out");
  } finally { cleanup(dir); }
});

test("sendSms retries once on 429", async () => {
  const { dir } = harness();
  try {
    let n = 0;
    const fakeFetch = async () => { n++; return n === 1 ? new Response("{}", { status: 429 }) : new Response("{}", { status: 200 }); };
    await sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, sleep: async () => {} });
    assert.equal(n, 2);
  } finally { cleanup(dir); }
});

// Regression tripwire: SMS_MAX_SENDS_PER_DAY=0 must be a KILL SWITCH ("no
// sends"), not "unlimited" -- the exact `&& MAX > 0` inversion a prior
// plan-review caught once already. sms-cli's `counter` is built once at
// module-evaluation time from the env var (createCounter reads it eagerly),
// and the top-of-file `sendSms` import already evaluated with no cap set --
// so this test forces a FRESH module instance (cache-busting query on the
// dynamic import) after setting the env, so its own `createCounter` call
// picks up MAX=0.
test("sendSms refuses when SMS_MAX_SENDS_PER_DAY=0 (kill switch) without ever calling fetch", async () => {
  const { dir } = harness();
  try {
    process.env.SMS_MAX_SENDS_PER_DAY = "0";
    const mod = await import(`./sms-cli.ts?kill-switch-${Date.now()}-${Math.random()}`);
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await assert.rejects(() => mod.sendSms("+15551234567", "hi", { fetchImpl: fakeFetch }), /cap/i);
    assert.equal(calls.length, 0);
  } finally { delete process.env.SMS_MAX_SENDS_PER_DAY; cleanup(dir); }
});

// Regression tripwire: the outbound transcript append must happen ONLY after
// a successful (2xx) POST -- a failed send must leave zero "out" entries, or
// the agent's own transcript would claim a reply was delivered when it wasn't.
test("sendSms appends nothing to the transcript when the POST fails (500)", async () => {
  const { dir } = harness();
  try {
    const fakeFetch = async () => new Response("{}", { status: 500 });
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch }));
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("+15551234567").filter((e) => e.direction === "out").length, 0);
  } finally { cleanup(dir); }
});

test("sendSms appends nothing to the transcript when both attempts 429", async () => {
  const { dir } = harness();
  try {
    let n = 0;
    const fakeFetch = async () => { n++; return new Response("{}", { status: 429 }); };
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, sleep: async () => {} }));
    assert.equal(n, 2);
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("+15551234567").filter((e) => e.direction === "out").length, 0);
  } finally { cleanup(dir); }
});

// Regression tripwire: the daily-cap count must be recorded BEFORE the POST
// (over-count-on-failure is the safe direction, matching mail/discord-cli) --
// so a failed send still burns a cap slot instead of letting a
// persistently-failing retry send unbounded while the counter stays frozen.
test("sendSms still records the daily-cap count after a failed send", async () => {
  const { dir } = harness();
  try {
    const fakeFetch = async () => new Response("{}", { status: 500 });
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch }));
    const { createCounter } = await import("./send-state.ts");
    const { SMS_SEND_STATE_PATH } = await import("./paths.ts");
    const counter = createCounter(SMS_SEND_STATE_PATH, "SMS_MAX_SENDS_PER_DAY", 500);
    assert.equal(counter.load().count, 1);
  } finally { cleanup(dir); }
});
