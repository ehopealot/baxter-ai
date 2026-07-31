// Tests for the moderation core: enablement gating, verdict parsing, fail-open behavior (a
// disabled/misconfigured/erroring check all allow), and the canned-reply mapping. The verifier
// call is injected -- no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { moderationEnabled, loadModConfig, parseVerdict, moderate, inboundBlockReply, outboundBlockNotice } from "./moderation.ts";
import type { VerifierCall } from "./moderation.ts";

const on = { MODERATION_ENABLED: "1", MODERATION_MODEL: "m", MODERATION_API_KEY: "k" } as NodeJS.ProcessEnv;

test("moderationEnabled: off by default, on with the flag, per-direction opt-out", () => {
  assert.equal(moderationEnabled("in", {}), false);
  assert.equal(moderationEnabled("in", { MODERATION_ENABLED: "1" }), true);
  assert.equal(moderationEnabled("out", { MODERATION_ENABLED: "1" }), true);
  assert.equal(moderationEnabled("in", { MODERATION_ENABLED: "1", MODERATION_INBOUND: "0" }), false);
  assert.equal(moderationEnabled("out", { MODERATION_ENABLED: "1", MODERATION_OUTBOUND: "0" }), false);
  // a per-direction opt-out doesn't affect the other direction
  assert.equal(moderationEnabled("in", { MODERATION_ENABLED: "1", MODERATION_OUTBOUND: "0" }), true);
});

test("loadModConfig: OPENROUTER_API_KEY fallback, base-url default+trim, timeout sanitized", () => {
  const c = loadModConfig({ MODERATION_MODEL: "x", OPENROUTER_API_KEY: "ok", MODERATION_TIMEOUT_MS: "bad" });
  assert.equal(c.apiKey, "ok"); // falls back to OPENROUTER_API_KEY
  assert.equal(c.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(c.timeoutMs, 4000); // NaN -> default
  const c2 = loadModConfig({ MODERATION_BASE_URL: "http://x/v1/", MODERATION_TIMEOUT_MS: "1000" });
  assert.equal(c2.baseUrl, "http://x/v1"); // trailing slash trimmed
  assert.equal(c2.timeoutMs, 1000);
});

test("parseVerdict: ALLOW, BLOCK <category>, unknown category -> other, unparseable -> allow", () => {
  assert.deepEqual(parseVerdict("ALLOW"), { allowed: true });
  assert.deepEqual(parseVerdict("BLOCK harassment: slur at someone"), { allowed: false, category: "harassment", reason: "slur at someone" });
  assert.equal(parseVerdict("block SEXUAL").category, "sexual"); // case-insensitive
  assert.equal(parseVerdict("BLOCK weirdcat: x").category, "other"); // unknown -> other
  assert.deepEqual(parseVerdict("I think this is fine, allow it"), { allowed: true }); // no BLOCK -> allow
  assert.deepEqual(parseVerdict(""), { allowed: true });
  assert.equal(parseVerdict("Sure -- BLOCK violence: threat").allowed, false); // tolerates leading text
});

test("moderate: disabled -> allow with no verifier call", async () => {
  let called = false;
  const call: VerifierCall = async () => { called = true; return "BLOCK other: x"; };
  const v = await moderate("anything", "in", { env: {}, call });
  assert.deepEqual(v, { allowed: true });
  assert.equal(called, false); // never called when disabled
});

test("moderate: empty text short-circuits to allow (no call)", async () => {
  let called = false;
  const call: VerifierCall = async () => { called = true; return "BLOCK other: x"; };
  const v = await moderate("   ", "in", { env: on, call });
  assert.deepEqual(v, { allowed: true });
  assert.equal(called, false);
});

test("moderate: enabled -> uses the verifier verdict (allow and block)", async () => {
  const allow: VerifierCall = async () => "ALLOW";
  assert.equal((await moderate("hi", "in", { env: on, call: allow })).allowed, true);
  const block: VerifierCall = async () => "BLOCK profanity: heavy swearing";
  const v = await moderate("$#@!", "out", { env: on, call: block });
  assert.deepEqual(v, { allowed: false, category: "profanity", reason: "heavy swearing" });
});

test("moderate: FAIL-OPEN + alert on a verifier error", async () => {
  const alerts: string[] = [];
  const boom: VerifierCall = async () => { throw new Error("timeout"); };
  const v = await moderate("hi", "in", { env: on, call: boom, alert: (m) => alerts.push(m) });
  assert.equal(v.allowed, true); // fail-open
  assert.match(alerts.join(" "), /verifier call failed.*fail-open/);
});

test("moderate: FAIL-OPEN + alert on a misconfig (enabled but no model)", async () => {
  const alerts: string[] = [];
  let called = false;
  const call: VerifierCall = async () => { called = true; return "ALLOW"; };
  const v = await moderate("hi", "in", { env: { MODERATION_ENABLED: "1", MODERATION_API_KEY: "k" }, call, alert: (m) => alerts.push(m) });
  assert.equal(v.allowed, true);
  assert.equal(called, false); // no call attempted without a model
  assert.match(alerts.join(" "), /MODERATION_MODEL is unset/);
});

test("inboundBlockReply: category-specific, deterministic with a pick, unknown -> other", () => {
  assert.match(inboundBlockReply("profanity", 0), /clean/i);
  assert.notEqual(inboundBlockReply("harassment", 0), inboundBlockReply("profanity", 0));
  assert.equal(inboundBlockReply("nonsense", 0), inboundBlockReply("other", 0)); // unknown folds to other
  assert.equal(inboundBlockReply(undefined, 0), inboundBlockReply("other", 0));
});

test("outboundBlockNotice tells the agent to apologize, not resend", () => {
  const n = outboundBlockNotice("sexual content");
  assert.match(n, /do NOT resend/);
  assert.match(n, /can't help with that/i);
  assert.match(n, /sexual content/);
});
