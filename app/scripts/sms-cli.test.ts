// core/app/scripts/sms-cli.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendSms, sendGroupSms, sendContactCard, sendReadReceipt, sendTypingIndicator } from "./sms-cli.ts";
import { appendTranscript } from "./sms-transcript.ts";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "sms-cli-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  process.env.SEND_STATE_DIR_OVERRIDE = dir;
  // T3 (usage-metrics): the sms_tx hook records into USAGE_DIR_OVERRIDE (read at
  // call time by signal-store.ts), so every scenario gets its own usage dir under
  // the harness dir -- successful sends land in <dir>/usage/signals.jsonl and the
  // record-nothing assertions count lines in exactly their own dir.
  process.env.USAGE_DIR_OVERRIDE = join(dir, "usage");
  process.env.SENDBLUE_API_KEY = "k"; process.env.SENDBLUE_API_SECRET = "s"; process.env.SENDBLUE_FROM_NUMBER = "+15559999999";
  return { dir };
}
const cleanup = (dir: string) => { for (const v of ["SMS_TRANSCRIPT_DIR_OVERRIDE","SEND_STATE_DIR_OVERRIDE","USAGE_DIR_OVERRIDE","SENDBLUE_API_KEY","SENDBLUE_API_SECRET","SENDBLUE_FROM_NUMBER"]) delete process.env[v]; rmSync(dir, { recursive: true, force: true }); };

// The parsed signals.jsonl rows for a harness dir ([] when nothing was recorded).
type SignalRow = { v?: number; t: number; kind: string; counterpart?: string };
function signalRows(dir: string): SignalRow[] {
  try {
    return readFileSync(join(dir, "usage", "signals.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as SignalRow);
  } catch {
    return [];
  }
}

function spawnSmsCli(args: string[], input = "") {
  const env = { ...process.env };
  delete env.SENDBLUE_API_KEY;
  delete env.SENDBLUE_API_SECRET;
  delete env.SENDBLUE_FROM_NUMBER;
  return spawnSync(process.execPath, [fileURLToPath(new URL("./sms-cli.ts", import.meta.url)), ...args], {
    env,
    input,
    encoding: "utf8",
  });
}

test("sms-cli skip resolves without credentials or transcript changes", async () => {
  const { dir } = harness();
  try {
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
    const { readTranscript } = await import("./sms-transcript.ts");
    const before = readTranscript("+15551234567").length;
    const result = spawnSmsCli(["skip"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), JSON.stringify({ skipped: true }));
    assert.equal(readTranscript("+15551234567").length, before);
  } finally { cleanup(dir); }
});

test("sms-cli skip reports a positional reason", () => {
  const { dir } = harness();
  try {
    const result = spawnSmsCli(["skip", "nothing actionable"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), JSON.stringify({ skipped: true }));
    assert.match(result.stderr, /nothing actionable/);
  } finally { cleanup(dir); }
});

test("sms-cli skip joins all positional reason words", () => {
  const { dir } = harness();
  try {
    const result = spawnSmsCli(["skip", "nothing", "actionable"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /reason=nothing actionable/);
  } finally { cleanup(dir); }
});

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

test("sendReadReceipt POSTs mark-read (number + from_number + auth) for a registered contact, and does NOT count a send", async () => {
  const { dir } = harness();
  try {
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" }); // the inbound that registers them
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "OK" }), { status: 200 }); };
    await sendReadReceipt("(555) 123-4567", { fetchImpl: fakeFetch });
    assert.match(calls[0].url, /\/api\/mark-read$/);
    assert.equal(calls[0].init.headers["sb-api-key-id"], "k");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.number, "+15551234567"); // normalized E.164, same as the transcript key
    assert.equal(body.from_number, "+15559999999");
    // Presence is not a message: no daily-cap count, no transcript append.
    const { createCounter } = await import("./send-state.ts");
    const { SMS_SEND_STATE_PATH } = await import("./paths.ts");
    assert.equal(createCounter(SMS_SEND_STATE_PATH, "SMS_MAX_SENDS_PER_DAY", 500).load().count, 0);
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("+15551234567").filter((e) => e.direction === "out").length, 0);
  } finally { cleanup(dir); }
});

test("sendTypingIndicator POSTs send-typing-indicator with the state for a registered contact", async () => {
  const { dir } = harness();
  try {
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await sendTypingIndicator("+15551234567", "start", { fetchImpl: fakeFetch });
    await sendTypingIndicator("+15551234567", "stop", { fetchImpl: fakeFetch });
    assert.match(calls[0].url, /\/api\/send-typing-indicator$/);
    assert.equal(JSON.parse(calls[0].init.body).state, "start");
    assert.equal(JSON.parse(calls[1].init.body).state, "stop");
  } finally { cleanup(dir); }
});

test("presence signals are refused for a number with NO transcript (never leak presence to a stranger), no network call", async () => {
  const { dir } = harness();
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await sendReadReceipt("+15551234567", { fetchImpl: fakeFetch });
    await sendTypingIndicator("+15551234567", "start", { fetchImpl: fakeFetch });
    assert.equal(calls.length, 0, "no fetch for a number that has never texted in");
  } finally { cleanup(dir); }
});

test("presence signals are best-effort: a non-2xx (non-iMessage recipient) does NOT throw", async () => {
  const { dir } = harness();
  try {
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
    const fakeFetch = async () => new Response(JSON.stringify({ error_message: "not iMessage" }), { status: 400 });
    // Must resolve, not reject -- presence is cosmetic; an SMS/green-bubble contact can't show it.
    await sendReadReceipt("+15551234567", { fetchImpl: fakeFetch });
    await sendTypingIndicator("+15551234567", "start", { fetchImpl: fakeFetch });
  } finally { cleanup(dir); }
});

test("sendGroupSms posts to /api/send-group-message with the group_id and appends to the group transcript", async () => {
  const { dir } = harness();
  try {
    // The group must have a transcript (received at least once) -- an inbound created it.
    await appendTranscript("group:grp_abc", { direction: "in", at: "t", content: "hi all", from: "+15551234567" });
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await sendGroupSms("grp_abc", "hi everyone", { fetchImpl: fakeFetch });
    assert.match(calls[0].url, /\/api\/send-group-message$/);
    assert.equal(calls[0].init.headers["sb-api-key-id"], "k");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.group_id, "grp_abc");
    assert.equal(body.from_number, "+15559999999");
    assert.equal(body.content, "hi everyone");
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("group:grp_abc").at(-1)!.direction, "out", "the reply is appended to the group thread");
  } finally { cleanup(dir); }
});

test("sendGroupSms refuses a group with no transcript (never received) and a missing group id, before any network call", async () => {
  const { dir } = harness();
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await assert.rejects(() => sendGroupSms("unknown_grp", "hi", { fetchImpl: fakeFetch }), /no transcript/i);
    await assert.rejects(() => sendGroupSms("", "hi", { fetchImpl: fakeFetch }), /missing group id/i);
    assert.equal(calls.length, 0, "fetch must never be called for an unregistered or empty group");
  } finally { cleanup(dir); }
});

// --- T3 (usage-metrics): sms_tx signal at the gatedSend tail ------------------------------
//
// Exactly ONE kind:"sms_tx" signal per SUCCESS path (recorded only after the
// Sendblue POST is accepted -- 2xx after the 429 retry loop) and ZERO on every
// refusal/failure path: cold outbound, invalid phone, the daily-cap kill switch,
// provider 500, double-429. gatedSend's `convId` is already canonical (sendSms
// passes normalizePhone's E.164, sendGroupSms passes group:<id>), so rx and tx
// for the same contact collapse onto one label series -- pinned here by sending
// to the SAME non-canonical spelling "(555) 123-4567" the sms_rx test uses.

test("sms_tx: a successful sendSms records exactly ONE signal with the canonical E.164 counterpart (rx and tx collapse onto one label series)", async () => {
  const { dir } = harness();
  try {
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
    const fakeFetch = async () => new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 });
    await sendSms("(555) 123-4567", "hello there", { fetchImpl: fakeFetch });
    const rows = signalRows(dir);
    assert.equal(rows.length, 1, "exactly one sms_tx per successful send");
    assert.equal(rows[0].kind, "sms_tx");
    assert.equal(rows[0].counterpart, "+15551234567", "the canonical form the sms_rx hook records for the same contact");
    assert.equal(rows[0].v, 1, "store-stamped version");
    assert.equal(typeof rows[0].t, "number");
  } finally { cleanup(dir); }
});

test("sms_tx: a successful sendGroupSms records counterpart group:<id>", async () => {
  const { dir } = harness();
  try {
    await appendTranscript("group:grp_abc", { direction: "in", at: "t", content: "hi all", from: "+15551234567" });
    const fakeFetch = async () => new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 });
    await sendGroupSms("grp_abc", "hi everyone", { fetchImpl: fakeFetch });
    const rows = signalRows(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "sms_tx");
    assert.equal(rows[0].counterpart, "group:grp_abc");
  } finally { cleanup(dir); }
});

test("sms_tx records NOTHING on refusal/failure: invalid phone, cold outbound, provider 500, double-429", async () => {
  // (a) invalid phone -- refused before any network call.
  {
    const { dir } = harness();
    try {
      const fakeFetch = async () => new Response("{}", { status: 200 });
      await assert.rejects(() => sendSms("not-a-phone", "hi", { fetchImpl: fakeFetch }), /not a valid phone number/i);
      assert.equal(signalRows(dir).length, 0, "invalid phone: no sms_tx");
    } finally { cleanup(dir); }
  }
  // (b) cold outbound -- a number with no transcript is refused before the cap or network.
  {
    const { dir } = harness();
    try {
      const fakeFetch = async () => new Response("{}", { status: 200 });
      await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch }), /never texted|no transcript/i);
      assert.equal(signalRows(dir).length, 0, "cold outbound: no sms_tx");
    } finally { cleanup(dir); }
  }
  // (c) provider 500 -- the POST failed, so nothing was sent.
  {
    const { dir } = harness();
    try {
      await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
      const fakeFetch = async () => new Response("{}", { status: 500 });
      await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch }));
      assert.equal(signalRows(dir).length, 0, "provider 500: no sms_tx");
    } finally { cleanup(dir); }
  }
  // (d) double-429 -- both attempts rate-limited, the send never went out.
  {
    const { dir } = harness();
    try {
      await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
      const fakeFetch = async () => new Response("{}", { status: 429 });
      await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, sleep: async () => {} }));
      assert.equal(signalRows(dir).length, 0, "double-429: no sms_tx");
    } finally { cleanup(dir); }
  }
});

// --- send-contact (spec 2026-08-15-first-contact-intro-design §4/§7) -------------------------
//
// The v1 contact-card method: the SAME /api/send-message endpoint as a normal send,
// body { number, media_url } with NO content field (media-only). Refuses fast without
// BAXTER_VCARD_URL and to a cold number; one sms_tx + a "[contact card]" transcript
// entry on success (all via gatedSend's shared tail).

test("send-contact: happy path POSTs number+media_url with NO content, appends '[contact card]', records ONE sms_tx", async () => {
  const { dir } = harness();
  process.env.BAXTER_VCARD_URL = "https://assets.example/baxter.vcf";
  try {
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await sendContactCard("(555) 123-4567", { fetchImpl: fakeFetch });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/send-message$/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.number, "+15551234567", "the phone is normalized E.164 like sendSms");
    assert.equal(body.media_url, "https://assets.example/baxter.vcf");
    assert.equal(body.from_number, "+15559999999");
    assert.equal("content" in body, false, "media-only message: no content field on the wire");
    const { readTranscript } = await import("./sms-transcript.ts");
    const out = readTranscript("+15551234567").filter((e) => e.direction === "out");
    assert.equal(out.length, 1);
    assert.equal(out[0].content, "[contact card]", "the transcript records the fixed marker, not a message body");
    const rows = signalRows(dir);
    assert.equal(rows.length, 1, "exactly one sms_tx on success");
    assert.equal(rows[0].kind, "sms_tx");
    assert.equal(rows[0].counterpart, "+15551234567");
  } finally { delete process.env.BAXTER_VCARD_URL; cleanup(dir); }
});

test("send-contact: refuses FAST when BAXTER_VCARD_URL is unset/blank, before any validation or network call", async () => {
  const { dir } = harness();
  try {
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    delete process.env.BAXTER_VCARD_URL;
    await assert.rejects(() => sendContactCard("+15551234567", { fetchImpl: fakeFetch }), /no BAXTER_VCARD_URL configured/i);
    process.env.BAXTER_VCARD_URL = "   ";
    await assert.rejects(() => sendContactCard("+15551234567", { fetchImpl: fakeFetch }), /no BAXTER_VCARD_URL configured/i);
    assert.equal(calls.length, 0, "fetch must never be called without a vcard URL");
    assert.equal(signalRows(dir).length, 0, "no sms_tx on refusal");
  } finally { delete process.env.BAXTER_VCARD_URL; cleanup(dir); }
});

test("send-contact: refuses a cold number (no transcript) and an invalid phone, before any cap count or network call", async () => {
  const { dir } = harness();
  process.env.BAXTER_VCARD_URL = "https://assets.example/baxter.vcf";
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await assert.rejects(() => sendContactCard("+15550000000", { fetchImpl: fakeFetch }), /never texted|no transcript/i);
    await assert.rejects(() => sendContactCard("not-a-phone", { fetchImpl: fakeFetch }), /not a valid phone number/i);
    assert.equal(calls.length, 0, "fetch must never be called for a cold/invalid number");
    const { createCounter } = await import("./send-state.ts");
    const { SMS_SEND_STATE_PATH } = await import("./paths.ts");
    assert.equal(createCounter(SMS_SEND_STATE_PATH, "SMS_MAX_SENDS_PER_DAY", 500).load().count, 0, "a refused card burns no cap slot");
    assert.equal(signalRows(dir).length, 0);
  } finally { delete process.env.BAXTER_VCARD_URL; cleanup(dir); }
});

test("send-contact records nothing to the transcript when the POST fails (500)", async () => {
  const { dir } = harness();
  process.env.BAXTER_VCARD_URL = "https://assets.example/baxter.vcf";
  try {
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
    const fakeFetch = async () => new Response("{}", { status: 500 });
    await assert.rejects(() => sendContactCard("+15551234567", { fetchImpl: fakeFetch }));
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("+15551234567").filter((e) => e.direction === "out").length, 0);
    assert.equal(signalRows(dir).length, 0, "no sms_tx on a failed POST");
  } finally { delete process.env.BAXTER_VCARD_URL; cleanup(dir); }
});

test("send-contact: the CLI verb dispatches (usage error on a missing number)", () => {
  // The dispatch-table wiring (the verb itself is fully covered above). Spawned with
  // creds stripped like every spawnSmsCli call; BAXTER_VCARD_URL unset so the verb
  // refuses fast regardless.
  const { dir } = harness();
  try {
    const result = spawnSmsCli(["send-contact"]);
    assert.notEqual(result.status, 0, "a missing number is a usage error");
    assert.match(result.stderr, /usage: sms-cli send-contact <number>/);
  } finally { cleanup(dir); }
});

// Kill-switch variant needs the cache-busted dynamic import (the daily-cap counter
// is built once at module-evaluation time from SMS_MAX_SENDS_PER_DAY), exactly like
// the existing kill-switch test above.
test("sms_tx records nothing when the SMS_MAX_SENDS_PER_DAY=0 kill switch refuses the send", async () => {
  const { dir } = harness();
  try {
    await appendTranscript("+15551234567", { direction: "in", at: "t", content: "hi" });
    process.env.SMS_MAX_SENDS_PER_DAY = "0";
    const mod = await import(`./sms-cli.ts?kill-switch-sig-${Date.now()}-${Math.random()}`);
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await assert.rejects(() => mod.sendSms("+15551234567", "hi", { fetchImpl: fakeFetch }), /cap/i);
    assert.equal(calls.length, 0);
    assert.equal(signalRows(dir).length, 0, "kill switch: no sms_tx");
  } finally { delete process.env.SMS_MAX_SENDS_PER_DAY; cleanup(dir); }
});
