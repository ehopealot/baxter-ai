// core/app/scripts/sms-cli.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaySmsDeliveries, sendSms, sendGroupSms, sendContactCard, sendReadReceipt, sendTypingIndicator } from "./sms-cli.ts";
import { acceptSmsOutput, prepareOutput, type SmsOutputOperation } from "./surface-output-receipts.ts";
import { appendTranscript } from "./sms-transcript.ts";
import { setSmsOptOut } from "./sms-opt-out.ts";

// Harness for BOTH gate families. Transcripts/send-state/usage live under a temp dir via
// process.env overrides, and the direct 1:1 verbs additionally exercise the §2 injection
// seam of the known-number-outbound spec: `env` + `allowlistPath` on SendDeps, pointing at
// a TEMP allowlist file + a controlled env object ({} -- differs from process.env, so
// admission provably reads the injected pair, not ambient runtime state). Admission runs
// the REAL loadAllowlist against these -- no fake loader -- so JSON rosters, missing-file
// fallback, and corrupt-file fallback are all the real behavior chain. The default roster
// lists +15551234567 (the number the send tests use); per-test rosters vary it.
interface Harness { dir: string; allowlistPath: string; seedEnv: NodeJS.ProcessEnv; }
function harness(roster: { senders?: unknown[]; recipients?: unknown[]; noFile?: boolean; corrupt?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "sms-cli-"));
  process.env.SMS_TRANSCRIPT_DIR_OVERRIDE = dir;
  process.env.SEND_STATE_DIR_OVERRIDE = dir;
  // T3 (usage-metrics): the sms_tx hook records into USAGE_DIR_OVERRIDE (read at
  // call time by signal-store.ts), so every scenario gets its own usage dir under
  // the harness dir -- successful sends land in <dir>/usage/signals.jsonl and the
  // record-nothing assertions count lines in exactly their own dir.
  process.env.USAGE_DIR_OVERRIDE = join(dir, "usage");
  process.env.SENDBLUE_API_KEY = "k"; process.env.SENDBLUE_API_SECRET = "s"; process.env.SENDBLUE_FROM_NUMBER = "+15559999999";
  const allowlistPath = join(dir, "allowlist.json");
  if (roster.corrupt) writeFileSync(allowlistPath, "{not json");
  else if (!roster.noFile) writeFileSync(allowlistPath, JSON.stringify({ senders: roster.senders ?? ["+15551234567"], recipients: roster.recipients ?? [], version: 1 }));
  return { dir, allowlistPath, seedEnv: {} };
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

// Household-roster admission (spec 2026-08-18-sms-known-number-outbound §1): a
// household-listed number is admitted with NO transcript at all -- the roster is the
// authorization boundary, the first successful outbound creates the transcript naturally.
test("sendSms posts to Sendblue for a household-listed number with NO transcript, and appends the first outbound transcript entry", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  try {
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("+15551234567").length, 0, "precondition: no local transcript exists");
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await sendSms("+15551234567", "hello there", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath });
    assert.equal(calls.length, 1, "the listed number reaches Sendblue despite no transcript");
    assert.match(calls[0].url, /\/api\/send-message$/);
    assert.equal(calls[0].init.headers["sb-api-key-id"], "k");
    assert.equal(calls[0].init.headers["sb-api-secret-key"], "s");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.number, "+15551234567");
    assert.equal(body.from_number, "+15559999999");
    assert.equal(body.content, "hello there");
    assert.equal(readTranscript("+15551234567").at(-1)!.direction, "out", "the successful first outbound creates the transcript via the append path");
  } finally { cleanup(dir); }
});

// Regression tripwire: normalize-then-validate must run BEFORE the household-roster
// admission and BEFORE any network call, so a digit-free / unparseable phone string
// is refused locally and can never reach Sendblue with the raw garbage value.
test("direct SMS and contact-card sends refuse a STOP-suppressed number before provider or quota side effects", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  process.env.SMS_OPT_OUT_PATH_OVERRIDE = join(dir, "opt-outs.json");
  process.env.BAXTER_VCARD_URL = "https://home.example.test/baxter.vcf";
  try {
    writeFileSync(join(dir, "opt-outs.json"), JSON.stringify({ version: 1, numbers: ["+15551234567"] }));
    const calls: unknown[] = [];
    const fakeFetch = async (...args: unknown[]) => { calls.push(args); return new Response("{}", { status: 200 }); };
    await assert.rejects(() => sendSms("(555) 123-4567", "hello", { fetchImpl: fakeFetch as any, env: seedEnv, allowlistPath }), /stopped messages/i);
    await assert.rejects(() => sendContactCard("+15551234567", { fetchImpl: fakeFetch as any, env: seedEnv, allowlistPath }), /stopped messages/i);
    assert.deepEqual(calls, [], "suppression is checked before either provider endpoint");
    const { createCounter } = await import("./send-state.ts");
    const { SMS_SEND_STATE_PATH } = await import("./paths.ts");
    assert.equal(createCounter(SMS_SEND_STATE_PATH, "SMS_MAX_SENDS_PER_DAY", 500).load().count, 0, "refused sends consume no daily quota");
    assert.deepEqual(signalRows(dir), [], "refused sends record no sms_tx signal");
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.deepEqual(readTranscript("+15551234567"), [], "refused sends append no outbound transcript entry");
  } finally {
    delete process.env.SMS_OPT_OUT_PATH_OVERRIDE; delete process.env.BAXTER_VCARD_URL; cleanup(dir);
  }
});

test("a direct provider request linearized before STOP may finish, while STOP waits then blocks later sends", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  process.env.SMS_OPT_OUT_PATH_OVERRIDE = join(dir, "opt-outs.json");
  try {
    let providerStarted!: () => void; const started = new Promise<void>(resolve => { providerStarted = resolve; });
    let releaseProvider!: () => void; const providerReleased = new Promise<void>(resolve => { releaseProvider = resolve; });
    const sending = sendSms("+15551234567", "already starting", {
      env: seedEnv, allowlistPath,
      fetchImpl: async () => { providerStarted(); await providerReleased; return new Response("{}", { status: 200 }); },
    });
    await started;
    let stopSettled = false;
    const stopping = Promise.resolve(setSmsOptOut("+15551234567", true)).then(() => { stopSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    const stopSettledWhileProviderHeld = stopSettled;
    releaseProvider();
    await sending;
    await stopping;
    assert.equal(stopSettledWhileProviderHeld, false, "STOP and a direct provider attempt share one cross-process linearization boundary");
    await assert.rejects(() => sendSms("+15551234567", "later", { env: seedEnv, allowlistPath, fetchImpl: async () => new Response("{}") }), /stopped messages/i);
  } finally { delete process.env.SMS_OPT_OUT_PATH_OVERRIDE; cleanup(dir); }
});

test("STOP during 429 backoff preempts the retry provider attempt", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  process.env.SMS_OPT_OUT_PATH_OVERRIDE = join(dir, "opt-outs.json");
  try {
    let sleepStarted!: () => void; const sleeping = new Promise<void>(resolve => { sleepStarted = resolve; });
    let releaseSleep!: () => void; const sleepReleased = new Promise<void>(resolve => { releaseSleep = resolve; });
    let calls = 0;
    const sending = sendSms("+15551234567", "retry me", {
      env: seedEnv, allowlistPath,
      fetchImpl: async () => { calls++; return new Response("{}", { status: calls === 1 ? 429 : 200 }); },
      sleep: async () => { sleepStarted(); await sleepReleased; },
    });
    await sleeping;
    await setSmsOptOut("+15551234567", true);
    releaseSleep();
    await assert.rejects(() => sending, /stopped messages/i);
    assert.equal(calls, 1, "no retry starts after STOP persists");
  } finally { delete process.env.SMS_OPT_OUT_PATH_OVERRIDE; cleanup(dir); }
});

test("direct SMS fails closed when the durable STOP state is corrupt", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  process.env.SMS_OPT_OUT_PATH_OVERRIDE = join(dir, "opt-outs.json");
  try {
    writeFileSync(join(dir, "opt-outs.json"), "{broken");
    const calls: unknown[] = [];
    await assert.rejects(
      () => sendSms("+15551234567", "hello", { fetchImpl: async (...args: unknown[]) => { calls.push(args); return new Response("{}", { status: 200 }); }, env: seedEnv, allowlistPath }),
      /opt-out state/i,
    );
    assert.deepEqual(calls, [], "unknown suppression state must never fail open to Sendblue");
  } finally { delete process.env.SMS_OPT_OUT_PATH_OVERRIDE; cleanup(dir); }
});

test("sendSms refuses a digit-free / invalid phone string, before any network call", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await assert.rejects(() => sendSms("not-a-phone", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /not a valid phone number/i);
    assert.equal(calls.length, 0, "fetch must never be called for an invalid phone string");
  } finally { cleanup(dir); }
});

// Regression tripwire: the admission key (the roster match), the wire value POSTed to
// Sendblue, and the transcript entry's own key must all be the SAME normalized E.164
// string -- not a mix of raw input and normalized form.
test("sendSms normalizes the phone once and uses the canonical E.164 for the roster match, the POST body, and the outbound transcript key", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  try {
    // The roster lists the CANONICAL form; the send uses a non-canonical spelling of
    // the same number and must still match it exactly after normalization.
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await sendSms("(555) 123-4567", "hello there", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.number, "+15551234567", "POST body must use the normalized E.164 number");
    const { readTranscript } = await import("./sms-transcript.ts");
    const out = readTranscript("+15551234567").filter((e) => e.direction === "out");
    assert.equal(out.length, 1, "the outbound transcript entry must be stored under the normalized E.164 key");
  } finally { cleanup(dir); }
});

test("durable SMS provider acceptance and transcript completion reconcile idempotently by work ID", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  process.env.SMS_DELIVERY_RECEIPTS_DIR_OVERRIDE = join(dir, "receipts");
  try {
    let calls = 0;
    const deps = {
      fetchImpl: async () => { calls++; return new Response(JSON.stringify({ message_id: "provider-1" }), { status: 200 }); },
      env: seedEnv, allowlistPath, workId: "b".repeat(64),
    };
    await sendSms("+15551234567", "durable hello", deps);
    await sendSms("+15551234567", "durable hello", deps);
    assert.equal(calls, 1, "completed receipt suppresses duplicate provider publication");
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("+15551234567").filter(entry => entry.direction === "out").length, 1);
  } finally { delete process.env.SMS_DELIVERY_RECEIPTS_DIR_OVERRIDE; cleanup(dir); }
});

test("provider-accepted SMS crash replay completes transcript/output without another provider call", async () => {
  const { dir } = harness();
  process.env.SMS_DELIVERY_RECEIPTS_DIR_OVERRIDE = join(dir, "receipts");
  try {
    const workId = "c".repeat(64);
    const operation: SmsOutputOperation = { kind: "sms", path: "/api/send-message", body: { from_number: "+15559999999", number: "+15551234567", content: "accepted" }, convId: "+15551234567", content: "accepted" };
    await prepareOutput("sms", workId, operation);
    await acceptSmsOutput(workId, operation, "provider-c", { message_id: "provider-c" });
    let calls = 0;
    const receipts = await replaySmsDeliveries(workId, { fetchImpl: async () => { calls++; return new Response("{}"); } });
    assert.equal(calls, 0);
    assert.deepEqual(receipts.map(receipt => receipt.providerId), ["provider-c"]);
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.deepEqual(readTranscript("+15551234567").filter(entry => entry.direction === "out").map(entry => entry.content), ["accepted"]);
  } finally { delete process.env.SMS_DELIVERY_RECEIPTS_DIR_OVERRIDE; cleanup(dir); }
});

test("sendSms retries once on 429", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  try {
    let n = 0;
    const fakeFetch = async () => { n++; return n === 1 ? new Response("{}", { status: 429 }) : new Response("{}", { status: 200 }); };
    await sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, sleep: async () => {}, env: seedEnv, allowlistPath });
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
  const { dir, allowlistPath, seedEnv } = harness();
  try {
    process.env.SMS_MAX_SENDS_PER_DAY = "0";
    const mod = await import(`./sms-cli.ts?kill-switch-${Date.now()}-${Math.random()}`);
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await assert.rejects(() => mod.sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /cap/i);
    assert.equal(calls.length, 0);
  } finally { delete process.env.SMS_MAX_SENDS_PER_DAY; cleanup(dir); }
});

// Regression tripwire: the outbound transcript append must happen ONLY after
// a successful (2xx) POST -- a failed send must leave zero "out" entries, or
// the agent's own transcript would claim a reply was delivered when it wasn't.
test("sendSms appends nothing to the transcript when the POST fails (500)", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  try {
    const fakeFetch = async () => new Response("{}", { status: 500 });
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }));
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("+15551234567").filter((e) => e.direction === "out").length, 0);
  } finally { cleanup(dir); }
});

test("sendSms appends nothing to the transcript when both attempts 429", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  try {
    let n = 0;
    const fakeFetch = async () => { n++; return new Response("{}", { status: 429 }); };
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, sleep: async () => {}, env: seedEnv, allowlistPath }));
    assert.equal(n, 2);
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("+15551234567").filter((e) => e.direction === "out").length, 0);
  } finally { cleanup(dir); }
});

// Regression tripwire: the daily-cap count must be recorded BEFORE the POST
// (over-count-on-failure is the safe direction, matching mail/discord-cli) --
// so a failed send still burns a cap slot instead of letting a
// persistently-failing retry send unbounded while the counter stays frozen.
// Security tripwire: the household roster is the outbound-SMS boundary. A valid
// but UNLISTED number must be refused BEFORE the daily-cap count is touched and
// BEFORE any network call -- otherwise a prompt-injected run holding schedule-cli
// could `schedule-cli add ... --sms <arbitrary number>` and use Baxter as an SMS
// exfiltration channel to any valid phone. Removing the admittedRecipient gate
// in sms-cli.ts's sendSms would let this send through (fetch called) -- that's
// the mutation this test is pinned against.
test("sendSms refuses a household-unlisted number, before any cap count or network call", async () => {
  const { dir, allowlistPath, seedEnv } = harness({ senders: ["+15550000000"] }); // someone else is listed
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /not a phone number listed for the household/);
    assert.equal(calls.length, 0, "fetch must never be called for an unlisted number");
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("+15551234567").length, 0, "no transcript entry should be appended");
    const { createCounter } = await import("./send-state.ts");
    const { SMS_SEND_STATE_PATH } = await import("./paths.ts");
    const counter = createCounter(SMS_SEND_STATE_PATH, "SMS_MAX_SENDS_PER_DAY", 500);
    assert.equal(counter.load().count, 0, "the daily-cap count must not be incremented on a refused send");
  } finally { cleanup(dir); }
});

test("sendSms admits a number listed ONLY in the roster's senders (senders half of senders ∪ recipients)", async () => {
  const { dir, allowlistPath, seedEnv } = harness({ senders: ["+15557654321"], recipients: [] });
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await sendSms("+15557654321", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath });
    assert.equal(calls.length, 1, "a senders-only listing admits the send");
  } finally { cleanup(dir); }
});

test("sendSms admits a number listed ONLY in the roster's recipients (recipients half of senders ∪ recipients)", async () => {
  const { dir, allowlistPath, seedEnv } = harness({ senders: [], recipients: ["+15557654322"] });
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await sendSms("+15557654322", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath });
    assert.equal(calls.length, 1, "a recipients-only listing admits the send");
  } finally { cleanup(dir); }
});

// Security tripwire for the strict roster-phone predicate: entries that are NOT strict
// E.164 phones are dropped BEFORE any comparison and can never be normalized into phone
// authorization. A digit-bearing email (+15551234567@txt.example.com -- whose digits
// normalizePhone would strip into a valid E.164 number) and a bare, unpunctuated digit
// string (15551234567 -- which normalizePhone would up-form to +15551234567) both count
// as unlisted: the embedded/matching number is refused.
test("sendSms never admits a number whose only roster near-match is a digit-bearing email or a bare digit string (strict predicate, no normalization of roster entries)", async () => {
  const { dir, allowlistPath, seedEnv } = harness({ senders: ["+15551234567@txt.example.com"], recipients: ["15551234567"] });
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /not a phone number listed for the household/);
    assert.equal(calls.length, 0, "no network call for a number matched only by non-phone roster entries");
  } finally { cleanup(dir); }
});

test("sendSms ignores malformed roster entries (free text, empty strings, non-strings) while a well-formed listed number in the same roster still admits", async () => {
  const { dir, allowlistPath, seedEnv } = harness({ senders: ["Mom's phone", "", 42], recipients: ["+15557778888"] });
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await sendSms("+15557778888", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath });
    assert.equal(calls.length, 1, "junk entries never block a well-formed listed number");
    // And the junk entries admit nothing of their own.
    await assert.rejects(() => sendSms("+15550000000", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /not a phone number listed for the household/);
    assert.equal(calls.length, 1);
  } finally { cleanup(dir); }
});

// Fail-closed family: an empty/missing/corrupt EFFECTIVE allowlist (file gone + no env
// seed, empty lists, corrupt JSON + no env seed) admits nobody -- loadAllowlist's own
// fallback contract, exercised end-to-end through the real loader on the send path.
test("sendSms fails closed: a missing allowlist file with no env seed refuses before any network call", async () => {
  const { dir, allowlistPath, seedEnv } = harness({ noFile: true });
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /not a phone number listed for the household/);
    assert.equal(calls.length, 0);
  } finally { cleanup(dir); }
});

test("sendSms fails closed: an empty roster (valid JSON, no entries) refuses", async () => {
  const { dir, allowlistPath, seedEnv } = harness({ senders: [], recipients: [] });
  try {
    const fakeFetch = async () => new Response("{}", { status: 200 });
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /not a phone number listed for the household/);
  } finally { cleanup(dir); }
});

test("sendSms fails closed: a corrupt allowlist file with no env seed refuses (loadAllowlist falls back to an empty seed)", async () => {
  const { dir, allowlistPath, seedEnv } = harness({ corrupt: true });
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /not a phone number listed for the household/);
    assert.equal(calls.length, 0);
  } finally { cleanup(dir); }
});

// Environment-seed fallback follows loadAllowlist's existing semantics: a missing file
// falls back to the env seed, and a strict-E.164 entry in ALLOWED_SENDERS admits.
test("sendSms admission honors loadAllowlist's env-seed fallback: ALLOWED_SENDERS lists the number with no file present", async () => {
  const { dir, allowlistPath } = harness({ noFile: true });
  try {
    const env: NodeJS.ProcessEnv = { ALLOWED_SENDERS: "+15557654323", ALLOWED_RECIPIENTS: "" };
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await sendSms("+15557654323", "hi", { fetchImpl: fakeFetch, env, allowlistPath });
    assert.equal(calls.length, 1, "the env seed admits when the file is absent");
    // A number the seed does not list is still refused.
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, env, allowlistPath }), /not a phone number listed for the household/);
    assert.equal(calls.length, 1);
  } finally { cleanup(dir); }
});

test("sendSms still records the daily-cap count after a failed send", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  try {
    const fakeFetch = async () => new Response("{}", { status: 500 });
    await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }));
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

test("sendGroupSms rejects a malformed group id BEFORE side effects: no provider request, no daily-cap consumption, no sms_tx, no transcript write (scheduled-sms-group spec tests 11+17)", async () => {
  const { dir } = harness();
  try {
    // A legacy-looking strict transcript for the LOSSY-STRIPPED form must not authorize
    // the raw malformed id (the pre-feature grp;evil/grpevil collision, now closed).
    await appendTranscript("group:grpevil", { direction: "in", at: "t", content: "hi", from: "+15551234567" });
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await assert.rejects(() => sendGroupSms("grp;evil", "hi", { fetchImpl: fakeFetch }), /not a valid group id/);
    // Before any provider request...
    assert.equal(calls.length, 0, "fetch must never be called for a malformed id");
    // ...before daily-cap accounting (the counter file is only created by record())...
    assert.equal(existsSync(join(dir, "send-state.json")), false, "no daily-cap consumption");
    // ...and before any signal or outbound transcript entry.
    assert.deepEqual(signalRows(dir), [], "no sms_tx signal for a refused send");
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("group:grpevil").length, 1, "the strict transcript gained no outbound entry");
    assert.equal(readTranscript("group:grp;evil").length, 0, "nothing was written for the malformed key either");
    // A transcript admitted at CREATION but deleted before FIRE is still refused at fire time.
    await appendTranscript("group:grp_gone", { direction: "in", at: "t", content: "hi", from: "+15551234567" });
    rmSync(join(dir, "g-grp_gone.jsonl"));
    await assert.rejects(() => sendGroupSms("grp_gone", "hi", { fetchImpl: fakeFetch }), /no transcript/i);
    assert.equal(calls.length, 0, "still no provider call");
  } finally { cleanup(dir); }
});

// --- T3 (usage-metrics): sms_tx signal at the gatedSend tail ------------------------------
//
// Exactly ONE kind:"sms_tx" signal per SUCCESS path (recorded only after the
// Sendblue POST is accepted -- 2xx after the 429 retry loop) and ZERO on every
// refusal/failure path: an unlisted number (refused at household-roster
// admission), invalid phone, the daily-cap kill switch, provider 500, double-429.
// gatedSend's `convId` is already canonical (sendSms passes normalizePhone's
// E.164, sendGroupSms passes group:<id>), so rx and tx for the same contact
// collapse onto one label series -- pinned here by sending to the SAME
// non-canonical spelling "(555) 123-4567" the sms_rx test uses.

test("sms_tx: a successful sendSms records exactly ONE signal with the canonical E.164 counterpart (rx and tx collapse onto one label series)", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  try {
    const fakeFetch = async () => new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 });
    await sendSms("(555) 123-4567", "hello there", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath });
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

test("sms_tx records NOTHING on refusal/failure: invalid phone, unlisted number, provider 500, double-429", async () => {
  // (a) invalid phone -- refused before any network call.
  {
    const { dir, allowlistPath, seedEnv } = harness();
    try {
      const fakeFetch = async () => new Response("{}", { status: 200 });
      await assert.rejects(() => sendSms("not-a-phone", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /not a valid phone number/i);
      assert.equal(signalRows(dir).length, 0, "invalid phone: no sms_tx");
    } finally { cleanup(dir); }
  }
  // (b) unlisted number -- refused at household-roster admission before the cap or network.
  {
    const { dir, allowlistPath, seedEnv } = harness({ senders: ["+15550000000"] });
    try {
      const fakeFetch = async () => new Response("{}", { status: 200 });
      await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /not a phone number listed for the household/);
      assert.equal(signalRows(dir).length, 0, "unlisted number: no sms_tx");
    } finally { cleanup(dir); }
  }
  // (c) provider 500 -- the POST failed, so nothing was sent.
  {
    const { dir, allowlistPath, seedEnv } = harness();
    try {
      const fakeFetch = async () => new Response("{}", { status: 500 });
      await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }));
      assert.equal(signalRows(dir).length, 0, "provider 500: no sms_tx");
    } finally { cleanup(dir); }
  }
  // (d) double-429 -- both attempts rate-limited, the send never went out.
  {
    const { dir, allowlistPath, seedEnv } = harness();
    try {
      const fakeFetch = async () => new Response("{}", { status: 429 });
      await assert.rejects(() => sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, sleep: async () => {}, env: seedEnv, allowlistPath }));
      assert.equal(signalRows(dir).length, 0, "double-429: no sms_tx");
    } finally { cleanup(dir); }
  }
});

// --- send-contact (spec 2026-08-15-first-contact-intro-design §4/§7) -------------------------
//
// The v1 contact-card method: the SAME /api/send-message endpoint as a normal send,
// body { number, media_url } with NO content field (media-only). Refuses fast without
// BAXTER_VCARD_URL and to a household-unlisted number (the same roster admission as
// `send`, via the same injected env/allowlistPath); one sms_tx + a "[contact card]"
// transcript entry on success (all via gatedSend's shared tail).

test("send-contact: happy path POSTs number+media_url with NO content for a household-listed number with NO transcript, appends '[contact card]', records ONE sms_tx", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  process.env.BAXTER_VCARD_URL = "https://assets.example/baxter.vcf";
  try {
    const { readTranscript } = await import("./sms-transcript.ts");
    assert.equal(readTranscript("+15551234567").length, 0, "precondition: no local transcript exists");
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await sendContactCard("(555) 123-4567", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/send-message$/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.number, "+15551234567", "the phone is normalized E.164 like sendSms");
    assert.equal(body.media_url, "https://assets.example/baxter.vcf");
    assert.equal(body.from_number, "+15559999999");
    assert.equal("content" in body, false, "media-only message: no content field on the wire");
    const out = readTranscript("+15551234567").filter((e) => e.direction === "out");
    assert.equal(out.length, 1);
    assert.equal(out[0].content, "[contact card]", "the transcript records the fixed marker, not a message body");
    const rows = signalRows(dir);
    assert.equal(rows.length, 1, "exactly one sms_tx on success");
    assert.equal(rows[0].kind, "sms_tx");
    assert.equal(rows[0].counterpart, "+15551234567");
  } finally { delete process.env.BAXTER_VCARD_URL; cleanup(dir); }
});

// §2 seam proof for send-contact: admission reads the INJECTED env (not ambient
// process state) -- with no file present, only the injected env seed's entry admits.
test("send-contact: admission reads the injected env (a no-file roster + ALLOWED_RECIPIENTS seed admits; a different number does not)", async () => {
  const { dir, allowlistPath } = harness({ noFile: true });
  process.env.BAXTER_VCARD_URL = "https://assets.example/baxter.vcf";
  try {
    const env: NodeJS.ProcessEnv = { ALLOWED_RECIPIENTS: "+15557654324" };
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ status: "QUEUED" }), { status: 200 }); };
    await sendContactCard("+15557654324", { fetchImpl: fakeFetch, env, allowlistPath });
    assert.equal(calls.length, 1, "the injected env seed admits through loadAllowlist's fallback");
    await assert.rejects(() => sendContactCard("+15551234567", { fetchImpl: fakeFetch, env, allowlistPath }), /not a phone number listed for the household/);
    assert.equal(calls.length, 1, "a number the injected env does not list is refused");
  } finally { delete process.env.BAXTER_VCARD_URL; cleanup(dir); }
});

test("send-contact: refuses FAST when BAXTER_VCARD_URL is unset/blank, before any validation or network call", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    delete process.env.BAXTER_VCARD_URL;
    await assert.rejects(() => sendContactCard("+15551234567", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /no BAXTER_VCARD_URL configured/i);
    process.env.BAXTER_VCARD_URL = "   ";
    await assert.rejects(() => sendContactCard("+15551234567", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /no BAXTER_VCARD_URL configured/i);
    assert.equal(calls.length, 0, "fetch must never be called without a vcard URL");
    assert.equal(signalRows(dir).length, 0, "no sms_tx on refusal");
  } finally { delete process.env.BAXTER_VCARD_URL; cleanup(dir); }
});

test("send-contact: refuses an unlisted number and an invalid phone, before any cap count or network call", async () => {
  const { dir, allowlistPath, seedEnv } = harness({ senders: ["+15550000000"] }); // someone else is listed
  process.env.BAXTER_VCARD_URL = "https://assets.example/baxter.vcf";
  try {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await assert.rejects(() => sendContactCard("+15551234567", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /not a phone number listed for the household/);
    await assert.rejects(() => sendContactCard("not-a-phone", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /not a valid phone number/i);
    assert.equal(calls.length, 0, "fetch must never be called for an unlisted/invalid number");
    const { createCounter } = await import("./send-state.ts");
    const { SMS_SEND_STATE_PATH } = await import("./paths.ts");
    assert.equal(createCounter(SMS_SEND_STATE_PATH, "SMS_MAX_SENDS_PER_DAY", 500).load().count, 0, "a refused card burns no cap slot");
    assert.equal(signalRows(dir).length, 0);
  } finally { delete process.env.BAXTER_VCARD_URL; cleanup(dir); }
});

test("send-contact records nothing to the transcript when the POST fails (500)", async () => {
  const { dir, allowlistPath, seedEnv } = harness();
  process.env.BAXTER_VCARD_URL = "https://assets.example/baxter.vcf";
  try {
    const fakeFetch = async () => new Response("{}", { status: 500 });
    await assert.rejects(() => sendContactCard("+15551234567", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }));
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
  const { dir, allowlistPath, seedEnv } = harness();
  try {
    process.env.SMS_MAX_SENDS_PER_DAY = "0";
    const mod = await import(`./sms-cli.ts?kill-switch-sig-${Date.now()}-${Math.random()}`);
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
    await assert.rejects(() => mod.sendSms("+15551234567", "hi", { fetchImpl: fakeFetch, env: seedEnv, allowlistPath }), /cap/i);
    assert.equal(calls.length, 0);
    assert.equal(signalRows(dir).length, 0, "kill switch: no sms_tx");
  } finally { delete process.env.SMS_MAX_SENDS_PER_DAY; cleanup(dir); }
});
