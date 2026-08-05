#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createCounter } from "./send-state.ts";
import { appendTranscript, hasTranscript } from "./sms-transcript.ts";
import { normalizePhone } from "./normalize-phone.ts";
import { SMS_KEYS_PATH, SMS_SEND_STATE_PATH } from "./paths.ts";

const API = "https://api.sendblue.co";

interface Creds { apiKey: string; apiSecret: string; fromNumber: string; }
export function creds(): Creds {
  const env = process.env;
  if (env.SENDBLUE_API_KEY && env.SENDBLUE_API_SECRET && env.SENDBLUE_FROM_NUMBER) {
    return { apiKey: env.SENDBLUE_API_KEY, apiSecret: env.SENDBLUE_API_SECRET, fromNumber: env.SENDBLUE_FROM_NUMBER };
  }
  try {
    const f = JSON.parse(readFileSync(SMS_KEYS_PATH, "utf8"));
    if (f.apiKey && f.apiSecret && f.fromNumber) return f;
  } catch { /* fall through */ }
  throw new Error("Sendblue credentials not set (no env vars and no keys file)");
}

const counter = createCounter(SMS_SEND_STATE_PATH, "SMS_MAX_SENDS_PER_DAY", 500);

// Narrower than `typeof fetch` (which accepts `string | Request | URL`) so a
// test double typed with a plain `string` url param stays assignable -- the
// global `fetch` itself still satisfies this narrower shape. Mirrors
// voice-brain.ts's injectable DecideFetchFn.
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
export interface SendDeps { fetchImpl?: FetchFn; sleep?: (ms: number) => Promise<void>; }
export async function sendSms(phone: string, content: string, deps: SendDeps = {}): Promise<unknown> {
  // Normalize once, up front, and use the canonical E.164 form everywhere below --
  // the registered-contacts gate key, the wire value POSTed to Sendblue, and the
  // stored transcript key must all be the SAME string, or the gate and the actual
  // send can diverge (e.g. a digit-free garbage input bucketing to unknown.jsonl
  // while the raw value still goes out over the wire).
  const norm = normalizePhone(phone);
  if (!norm) throw new Error(`sms send refused: ${phone} is not a valid phone number`);
  // Registered-contacts-only: refuse cold outbound to a number that has never
  // texted in (no transcript file yet). Must be the VERY FIRST check -- before
  // the daily-cap count and before any network call -- so a refused send burns
  // neither. A normal reply is unaffected: the inbound that triggered it
  // already created the transcript. See sms-transcript.ts's hasTranscript.
  if (!hasTranscript(norm)) throw new Error(`sms send refused: ${norm} has never texted (no transcript) — cold outbound is not allowed`);
  const f: FetchFn = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const c = creds();
  if (counter.load().count >= counter.MAX) throw new Error(`sms daily send cap (${counter.MAX}) reached`); // 0 = kill switch (parseMaxSends keeps 0 as "off")
  await counter.record(); // record-before-send (over-count-on-failure is the safe direction)
  let res: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await f(`${API}/api/send-message`, {
      method: "POST",
      headers: { "sb-api-key-id": c.apiKey, "sb-api-secret-key": c.apiSecret, "Content-Type": "application/json" },
      body: JSON.stringify({ number: norm, from_number: c.fromNumber, content }),
    });
    if (res.status === 429) { await sleep(1100); continue; } // 1 msg/sec
    break;
  }
  if (!res || !res.ok) throw new Error(`Sendblue send -> ${res ? res.status : "no response"}`);
  const out = await res.json().catch(() => ({}));
  await appendTranscript(norm, { direction: "out", at: new Date().toISOString(), content }); // outbound owner (spec §4.7)
  return out;
}

// --- Presence signals: read receipts + typing indicators (spec: SMS UX polish) ------------
// Both are iMessage/RCS-only Sendblue features (no-op for green-bubble SMS), keyed by number
// (no message id), and BEST-EFFORT: cosmetic, so a non-2xx (e.g. an SMS contact that can't show
// them) is NOT an error here -- we read the body and move on, never throwing on status. They are
// NOT messages: no daily-cap count and no transcript append. Sent ONLY to registered contacts
// (a number with a transcript -- always true for the inbound sender that triggers them), so a
// presence signal can never leak to a stranger. The daemon (which holds the creds) calls these;
// the agent run never does. Reuses the same API host + auth headers as sendSms.
export interface PresenceDeps { fetchImpl?: FetchFn; }
async function sendPresence(path: string, extra: Record<string, unknown>, phone: string, deps: PresenceDeps): Promise<unknown> {
  const norm = normalizePhone(phone);
  if (!norm) return { skipped: "invalid-number" };
  if (!hasTranscript(norm)) return { skipped: "no-transcript" }; // presence only to registered contacts
  const c = creds();
  const f: FetchFn = deps.fetchImpl ?? fetch;
  const res = await f(`${API}${path}`, {
    method: "POST",
    headers: { "sb-api-key-id": c.apiKey, "sb-api-secret-key": c.apiSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ number: norm, from_number: c.fromNumber, ...extra }),
  });
  return res.json().catch(() => ({})); // best-effort: non-2xx (non-iMessage recipient) is not exceptional
}
// Mark the inbound conversation read, so the sender sees "Read". Send on each new inbound.
export function sendReadReceipt(phone: string, deps: PresenceDeps = {}): Promise<unknown> {
  return sendPresence("/api/mark-read", {}, phone, deps);
}
// Show/hide the "…" typing bubble. state "start" when a run begins, "stop" when it ends.
// The `state` field is a documented Sendblue capability, NOT an assumption:
// https://docs.sendblue.com/api-v2/typing-indicators/ -- body accepts state "start" (default)
// or "stop"; "stop" ENDS an active indicator before its max_duration_ms (~60s default) expires,
// and stop-on-an-inactive-indicator is a safe no-op. This is load-bearing for the finally
// "stop" in sms-bot.ts: because sendPresence swallows non-2xx (best-effort), a silent contract
// drift here wouldn't self-surface -- if this endpoint's `state` semantics ever change, that
// "stop" would instead re-trigger the bubble (the phantom-typing artifact), so keep this cited.
// The bubble also auto-expires and an incoming reply clears it, so we never re-send "start"
// mid-run (that would show a phantom "typing" AFTER the reply already landed).
export function sendTypingIndicator(phone: string, state: "start" | "stop" = "start", deps: PresenceDeps = {}): Promise<unknown> {
  return sendPresence("/api/send-typing-indicator", { state }, phone, deps);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , cmd, ...rest] = process.argv;
  (async () => {
    try {
      if (cmd === "send") { console.log(JSON.stringify(await sendSms(rest[0], await readStdin()))); }
      else { console.error(`unknown command: ${cmd}`); process.exit(1); }
    } catch (err) { console.error(String(err)); process.exit(1); }
  })();
}
