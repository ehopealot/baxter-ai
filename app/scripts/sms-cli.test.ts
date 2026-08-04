// core/app/scripts/sms-cli.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendSms } from "./sms-cli.ts";
import { appendTranscript } from "./sms-transcript.ts";

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
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
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

// Regression tripwire: normalize-then-validate must run BEFORE the
// registered-contacts gate and BEFORE any network call, so a digit-free /
// unparseable phone string can never sneak past hasTranscript's own internal
// normalization (which buckets digit-free input to unknown.jsonl) and reach
// Sendblue with the raw garbage value.
test("sendSms refuses a digit-free / invalid phone string, before any network call", async () => {
  const { dir } = harness();
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await assert.rejects(() => sendSms("not-a-phone", "hi", { fetchImpl: fakeFetch }), /not a valid phone number/i);
    assert.equal(calls.length, 0, "fetch must never be called for an invalid phone string");
  } finally { cleanup(dir); }
});

// Regression tripwire: the gate key (hasTranscript), the wire value POSTed to
// Sendblue, and the transcript entry's own key must all be the SAME
// normalized E.164 string -- not a mix of raw input and normalized form.
test("sendSms normalizes the phone once and uses the canonical E.164 for both the POST body and the outbound transcript key", async () => {
  const { dir } = harness();
  try {
    // Seed the transcript under the CANONICAL form (what a real inbound would
    // have created), then send using a non-canonical spelling of the same number.
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await sendSms("(555) 123-4567", "hello there", { fetchImpl: fakeFetch });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.number, "+15551234567", "POST body must use the normalized E.164 number");
    const { readTranscript } = await import("./sms-transcript.ts");
    const out = readTranscript("+15551234567").filter((e) => e.direction === "out");
    assert.equal(out.length, 1, "the outbound transcript entry must be stored under the normalized E.164 key");
  } finally { cleanup(dir); }
});

test("sendSms retries once on 429", async () => {
  const { dir } = harness();
  try {
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
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
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
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
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
    const fakeFetch = async () => new Response("{}", { status: 500 });
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch }));
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("+15551234567").filter((e) => e.direction === "out").length, 0);
  } finally { cleanup(dir); }
});

test("sendSms appends nothing to the transcript when both attempts 429", async () => {
  const { dir } = harness();
  try {
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
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
// Security tripwire: registered-contacts-only. A number with no prior
// transcript (never texted in) must be refused BEFORE the daily-cap count is
// touched and BEFORE any network call -- otherwise a prompt-injected run
// holding schedule-cli could `schedule-cli add ... --sms <arbitrary number>`
// and use Baxter as a cold-outbound SMS exfiltration channel. Removing the
// `hasTranscript` gate in sms-cli.ts's sendSms would let this cold send
// through (fetch called) -- that's the mutation this test is pinned against.
test("sendSms refuses a number with no transcript, before any cap count or network call", async () => {
  const { dir } = harness();
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch }), /never texted|no transcript/i);
    assert.equal(calls.length, 0, "fetch must never be called for a cold number");
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("+15551234567").length, 0, "no transcript entry should be appended");
    const { createCounter } = await import("./send-state.ts");
    const { SMS_SEND_STATE_PATH } = await import("./paths.ts");
    const counter = createCounter(SMS_SEND_STATE_PATH, "SMS_MAX_SENDS_PER_DAY", 500);
    assert.equal(counter.load().count, 0, "the daily-cap count must not be incremented on a refused cold send");
  } finally { cleanup(dir); }
});

test("sendSms still records the daily-cap count after a failed send", async () => {
  const { dir } = harness();
  try {
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
    const fakeFetch = async () => new Response("{}", { status: 500 });
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch }));
    const { createCounter } = await import("./send-state.ts");
    const { SMS_SEND_STATE_PATH } = await import("./paths.ts");
    const counter = createCounter(SMS_SEND_STATE_PATH, "SMS_MAX_SENDS_PER_DAY", 500);
    assert.equal(counter.load().count, 1);
  } finally { cleanup(dir); }
});
