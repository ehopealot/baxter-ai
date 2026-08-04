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
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.number, "+15551234567");
    assert.equal(body.from_number, "+15559999999");
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
