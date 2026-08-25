#!/usr/bin/env node
import { reportSkip } from "./cli-flags.ts";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createCounter } from "./send-state.ts";
import { appendTranscript, hasTranscript, isStrictGroupId } from "./sms-transcript.ts";
import { normalizePhone } from "./normalize-phone.ts";
import { isSmsOptedOut, withSmsOptOutGate } from "./sms-opt-out.ts";
import { recordSignal } from "./signal-store.ts";
import { SMS_KEYS_PATH, SMS_SEND_STATE_PATH, ALLOWLIST_PATH } from "./paths.ts";
import { loadAllowlist, admittedRosterPhone } from "./allowlist.ts";
import type { LoaderDiagnosticSink } from "./allowlist.ts";

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
export interface SendDeps {
  fetchImpl?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  // Recipient-admission injection (spec 2026-08-18-sms-known-number-outbound §2): the
  // direct 1:1 verbs (`send` / `send-contact`) read the household roster through the REAL
  // loadAllowlist(env, allowlistPath) with these injectable inputs (defaults: process.env
  // / ALLOWLIST_PATH), so tests drive a temporary allowlist file + controlled env instead
  // of runtime state -- the same injection pattern as loadAllowlist's own env/path params
  // and householdPreamble's. No fake loader or precomputed roster is substituted.
  env?: NodeJS.ProcessEnv;
  allowlistPath?: string;
  diagnostic?: LoaderDiagnosticSink;
  // Proactive delivery supplies a bounded AbortSignal. Ordinary CLI sends omit
  // it and retain their existing behavior.
  signal?: AbortSignal;
}
// The shared send tail, run by callers AFTER each has performed its OWN admission --
// `send` and `send-contact` via household-roster admission (admittedRecipient, on the
// requested normalized number), `send-group` via transcript admission (hasTranscript,
// on the group key). gatedSend itself is admission-agnostic. Owns the invariant
// sequence -- daily-cap check, record-before-send, the 2-attempt 429 backoff (1
// msg/sec), error shaping, and the outbound-owner transcript append -- in ONE place so
// the 1:1 and group paths can't drift. `from_number` is injected
// here; the caller supplies the rest of the body (number / group_id) and the transcript key.
async function gatedSend(path: string, body: Record<string, unknown>, convId: string, content: string, deps: SendDeps, directPhone?: string): Promise<unknown> {
  const f: FetchFn = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const c = creds();
  if (counter.load().count >= counter.MAX) throw new Error(`sms daily send cap (${counter.MAX}) reached`); // 0 = kill switch (parseMaxSends keeps 0 as "off")
  await counter.record(); // record-before-send (over-count-on-failure is the safe direction)
  let res: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (deps.signal?.aborted) throw deps.signal.reason ?? new Error("Sendblue request aborted");
    const providerAttempt = () => f(`${API}${path}`, {
      method: "POST",
      headers: { "sb-api-key-id": c.apiKey, "sb-api-secret-key": c.apiSecret, "Content-Type": "application/json" },
      body: JSON.stringify({ from_number: c.fromNumber, ...body }),
      signal: deps.signal,
    });
    // The early direct gate at each caller preserves refusal-before-quota for an already
    // suppressed number. This second gate is after the asynchronous quota reservation and
    // wraps each individual provider attempt, closing races with a newly received STOP.
    res = directPhone ? await withSmsOptOutGate(directPhone, providerAttempt) : await providerAttempt();
    if (res.status === 429) {
      await sleep(1100);
      if (deps.signal?.aborted) throw deps.signal.reason ?? new Error("Sendblue request aborted");
      continue;
    } // 1 msg/sec
    break;
  }
  if (!res || !res.ok) throw new Error(`Sendblue ${path} -> ${res ? res.status : "no response"}`);
  // Usage metering (usage-metrics spec §2): exactly ONE sms_tx signal per success path,
  // zero on every refusal/failure (a destination refused at its caller's admission -- an
  // unlisted number, an unknown group -- invalid phone, cap kill switch, provider
  // 500 / double-429) -- the provider just accepted (2xx after the 429 retry loop), so the
  // message counts as sent. `convId` is already canonical (sendSms passes normalizePhone's
  // E.164, sendGroupSms passes group:<id>), matching the sms_rx hook's counterpart form so
  // rx and tx for the same contact collapse onto one label series. recordSignal never
  // throws, so the send tail stays safe.
  recordSignal({ t: Date.now(), kind: "sms_tx", counterpart: convId });
  const out = await res.json().catch(() => ({}));
  await appendTranscript(convId, { direction: "out", at: new Date().toISOString(), content }); // outbound owner (spec §4.7)
  return out;
}

// Direct-recipient admission for the 1:1 send verbs (spec 2026-08-18-sms-known-number-
// outbound §1): the JSON household roster (via the REAL loadAllowlist) is the
// authorization boundary -- a local SMS transcript is conversation history only, never
// authorization. A send is admitted when a predicate-passing entry in senders ∪
// recipients equals the requested normalized E.164 number EXACTLY -- the ONE shared
// strict predicate, admittedRosterPhone (allowlist.ts; see its comment for the strict
// E.164 shape and the never-normalize rationale). Fail-closed rides
// loadAllowlist's own contract: a missing/corrupt file falls back to the app.env seed, and
// an empty effective list admits nobody. OPERATOR_EMAIL is not an SMS destination and is
// not consulted. Read-only: this never writes allowlist state.
function admittedRecipient(norm: string, deps: SendDeps): boolean {
  return admittedRosterPhone(loadAllowlist(deps.env ?? process.env, deps.allowlistPath ?? ALLOWLIST_PATH, deps.diagnostic), norm);
}

export async function sendSms(phone: string, content: string, deps: SendDeps = {}): Promise<unknown> {
  // Normalize once, up front, and use the canonical E.164 form everywhere below --
  // the household-roster admission key, the wire value POSTed to Sendblue, and the
  // stored transcript key must all be the SAME string, or the gate and the actual
  // send can diverge (e.g. a digit-free garbage input bucketing to unknown.jsonl
  // while the raw value still goes out over the wire).
  const norm = normalizePhone(phone);
  if (!norm) throw new Error(`sms send refused: ${phone} is not a valid phone number`);
  if (isSmsOptedOut(norm)) throw new Error(`sms send refused: ${norm} stopped messages`);
  // Household-roster admission: a direct 1:1 send is authorized by the household roster,
  // NOT by local transcript history -- a listed number may be texted even if it has never
  // texted in. Must run BEFORE the daily-cap count and before any network call, so a
  // refused send burns neither. Sendblue's response is the source of truth for
  // reachability once the destination is admitted.
  if (!admittedRecipient(norm, deps)) throw new Error(`sms send refused: ${norm} is not a phone number listed for the household`);
  return gatedSend("/api/send-message", { number: norm, content }, norm, content, deps, norm);
}

// Reply INTO a group, via Sendblue's /api/send-group-message with the inbound group_id
// (docs.sendblue.com/api/resources/groups/methods/send_message). The message reaches every
// participant. Transcript admission keyed on the group conversation (hasTranscript on
// `group:<id>` -- a provider group id is not a household phone number, and the local group
// transcript is the proof Baxter received that conversation) + the same shared send tail as
// sendSms. Unlike a 1:1 send, a group is NOT admitted by the household roster. Reused by
// the `send-group` verb and the unsent-reply poke (isDeliveryCall recognizes it, so a real
// send never double-pokes).
export async function sendGroupSms(groupId: string, content: string, deps: SendDeps = {}): Promise<unknown> {
  if (!groupId) throw new Error("sms send-group refused: missing group id");
  // Strict ID validation FIRST (the one shared predicate, spec 2026-08-18-scheduled-sms-
  // group-delivery §Group ID boundary): it runs before the transcript lookup, the daily
  // cap, and any provider request, so a malformed id (e.g. "grp;evil") is refused with
  // no side effects -- and hasTranscript below always resolves the exact strict
  // g-<id>.jsonl file, never a gx-* quarantine transcript (which never authorizes).
  if (!isStrictGroupId(groupId)) throw new Error(`sms send-group refused: ${JSON.stringify(groupId)} is not a valid group id`);
  const convId = `group:${groupId}`;
  // Transcript-admitted-only: refuse a group with no transcript (never received an
  // inbound). A normal reply is unaffected -- the inbound that triggered it created the group
  // transcript -- so this only refuses outbound to an arbitrary, never-seen group id.
  // Deleting the transcript therefore also revokes an already-created schedule at fire time.
  if (!hasTranscript(convId)) throw new Error(`sms send-group refused: group ${groupId} has no transcript (never received) — cold outbound is not allowed`);
  return gatedSend("/api/send-group-message", { group_id: groupId, content }, convId, content, deps);
}

// Send Baxter's tappable CONTACT CARD (.vcf) to a household-listed 1:1 contact -- the v1
// contact-card method from Sendblue's docs: the SAME /api/send-message endpoint as a
// normal send, with `media_url` pointing at a publicly-hosted .vcf and NO `content`
// field (a media-only message). Called by the agent on the household's FIRST SMS
// exchange, when the first-contact intro's card block renders (see intro-state.ts /
// spec 2026-08-15-first-contact-intro-design §4). Uses the SAME household-roster
// admission rule (and the same injected env/allowlistPath) as `send`, so the two direct
// 1:1 verbs stay consistent; the remaining send gates come via gatedSend's shared
// tail: daily cap (record-before-send), the 1-msg/sec 429 retry, error shaping, one
// sms_tx signal, and the outbound-owner transcript append (content recorded as the
// fixed "[contact card]" marker).
export async function sendContactCard(phone: string, deps: SendDeps = {}): Promise<unknown> {
  // Refuse FAST on the missing config: a bare BAXTER_VCARD_URL would send a message
  // with an empty media_url (or worse), not a card. This is a config error, checked
  // before any phone validation or network work.
  const vcardUrl = (process.env.BAXTER_VCARD_URL ?? "").trim();
  if (!vcardUrl) throw new Error("sms-cli send-contact refused: no BAXTER_VCARD_URL configured");
  const norm = normalizePhone(phone);
  if (!norm) throw new Error(`sms-cli send-contact refused: ${phone} is not a valid phone number`);
  if (isSmsOptedOut(norm)) throw new Error(`sms-cli send-contact refused: ${norm} stopped messages`);
  // Household-roster admission, exactly like send: a listed number may be offered the
  // card even before its first inbound. Refused before the daily cap and any network call.
  if (!admittedRecipient(norm, deps)) throw new Error(`sms-cli send-contact refused: ${norm} is not a phone number listed for the household`);
  return gatedSend("/api/send-message", { number: norm, media_url: vcardUrl }, norm, "[contact card]", deps, norm);
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
      else if (cmd === "send-group") {
        if (!rest[0]) { console.error("usage: sms-cli send-group <group_id>"); process.exit(1); }
        console.log(JSON.stringify(await sendGroupSms(rest[0], await readStdin())));
      }
      else if (cmd === "send-contact") {
        if (!rest[0]) { console.error("usage: sms-cli send-contact <number>"); process.exit(1); }
        console.log(JSON.stringify(await sendContactCard(rest[0])));
      }
      else if (cmd === "skip") {
        const stdinText = await readStdin();
        reportSkip("sms", rest, stdinText);
      }
      else { console.error(`unknown command: ${cmd}`); process.exit(1); }
    } catch (err) { console.error(String(err)); process.exit(1); }
  })();
}
