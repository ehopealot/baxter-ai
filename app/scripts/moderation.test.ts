// Tests for the moderation core: enablement gating, the OpenAI-result -> Verdict threshold policy,
// fail-open behavior (a disabled/misconfigured/erroring check all allow), and the canned-reply
// mapping. The moderations-endpoint call is injected -- no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { moderationEnabled, loadModConfig, classifyOpenAiResult, moderate, inboundBlockReply, outboundBlockNotice } from "./moderation.ts";
import type { ModerationCall, OpenAiModerationResult } from "./moderation.ts";

const on = { MODERATION_ENABLED: "1", MODERATION_OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv;
const cfg = loadModConfig({}); // defaults: hard 0.5, soft 0.85
const scores = (s: Record<string, number>): OpenAiModerationResult => ({ category_scores: s });

test("moderationEnabled: off by default, on with the flag, per-direction opt-out", () => {
  assert.equal(moderationEnabled("in", {}), false);
  assert.equal(moderationEnabled("in", { MODERATION_ENABLED: "1" }), true);
  assert.equal(moderationEnabled("out", { MODERATION_ENABLED: "1" }), true);
  assert.equal(moderationEnabled("in", { MODERATION_ENABLED: "1", MODERATION_INBOUND: "0" }), false);
  assert.equal(moderationEnabled("out", { MODERATION_ENABLED: "1", MODERATION_OUTBOUND: "0" }), false);
  // opting out ONE direction leaves the other on
  assert.equal(moderationEnabled("in", { MODERATION_ENABLED: "1", MODERATION_OUTBOUND: "0" }), true);
});

test("loadModConfig: OpenAI defaults; overrides + base-url trim + threshold/timeout sanitize", () => {
  const d = loadModConfig({});
  assert.equal(d.apiKey, "");
  assert.equal(d.model, "omni-moderation-latest");
  assert.equal(d.baseUrl, "https://api.openai.com/v1");
  assert.equal(d.hardThreshold, 0.5);
  assert.equal(d.softThreshold, 0.85);
  assert.equal(d.timeoutMs, 4000);
  const o = loadModConfig({
    MODERATION_OPENAI_API_KEY: " sk-x ", MODERATION_OPENAI_MODEL: "text-moderation-latest",
    MODERATION_OPENAI_BASE_URL: "https://proxy.example/v1/", MODERATION_HARD_THRESHOLD: "0.3",
    MODERATION_SOFT_THRESHOLD: "0.9", MODERATION_TIMEOUT_MS: "2000",
  });
  assert.equal(o.apiKey, "sk-x");
  assert.equal(o.model, "text-moderation-latest");
  assert.equal(o.baseUrl, "https://proxy.example/v1"); // trailing slash trimmed
  assert.equal(o.hardThreshold, 0.3);
  assert.equal(o.softThreshold, 0.9);
  assert.equal(o.timeoutMs, 2000);
  // garbage falls back to defaults
  const bad = loadModConfig({ MODERATION_HARD_THRESHOLD: "abc", MODERATION_TIMEOUT_MS: "0" });
  assert.equal(bad.hardThreshold, 0.5);
  assert.equal(bad.timeoutMs, 4000); // 0 is below the min-1 timeout
});

test("classifyOpenAiResult: hard category blocks on a weak signal, soft only on a strong one", () => {
  // a HARD category (sexual/minors) at 0.6 blocks (>= hard 0.5)
  const hard = classifyOpenAiResult(scores({ "sexual/minors": 0.6, harassment: 0.4 }), cfg);
  assert.equal(hard.allowed, false);
  assert.equal(hard.category, "sexual");
  assert.match(hard.reason!, /sexual\/minors 0\.60/);
  // a SOFT category (harassment) at 0.6 ALLOWS (< soft 0.85) ...
  assert.equal(classifyOpenAiResult(scores({ harassment: 0.6 }), cfg).allowed, true);
  // ... but at 0.9 blocks
  const soft = classifyOpenAiResult(scores({ harassment: 0.9 }), cfg);
  assert.equal(soft.allowed, false);
  assert.equal(soft.category, "harassment");
});

test("classifyOpenAiResult: clean allows; bare flagged is NOT trusted; picks the highest crosser", () => {
  assert.equal(classifyOpenAiResult(scores({ harassment: 0.1, sexual: 0.05 }), cfg).allowed, true);
  // an endpoint `flagged:true` with all scores below our thresholds still ALLOWS
  assert.equal(classifyOpenAiResult({ flagged: true, category_scores: { harassment: 0.6 } }, cfg).allowed, true);
  // two crossers -> the higher-scoring category wins
  const both = classifyOpenAiResult(scores({ "sexual/minors": 0.7, "violence/graphic": 0.95 }), cfg);
  assert.equal(both.category, "violence");
  // a missing/garbled result fails toward ALLOW
  assert.equal(classifyOpenAiResult({}, cfg).allowed, true);
  assert.equal(classifyOpenAiResult({ category_scores: { harassment: "x" as unknown as number } }, cfg).allowed, true);
});

test("classifyOpenAiResult: category mapping (hate->harassment, self-harm->other)", () => {
  assert.equal(classifyOpenAiResult(scores({ "hate/threatening": 0.6 }), cfg).category, "harassment");
  assert.equal(classifyOpenAiResult(scores({ "self-harm/instructions": 0.6 }), cfg).category, "other");
});

test("moderate: disabled -> allow with no endpoint call", async () => {
  let called = false;
  const call: ModerationCall = async () => { called = true; return scores({ "sexual/minors": 0.99 }); };
  const v = await moderate("anything", "in", { env: {}, call });
  assert.deepEqual(v, { allowed: true });
  assert.equal(called, false);
});

test("moderate: empty text short-circuits to allow (no call)", async () => {
  let called = false;
  const call: ModerationCall = async () => { called = true; return scores({ "sexual/minors": 0.99 }); };
  const v = await moderate("   ", "in", { env: on, call });
  assert.equal(v.allowed, true);
  assert.equal(called, false);
});

test("moderate: enabled -> classifies the endpoint result (allow and block)", async () => {
  const clean: ModerationCall = async () => scores({ harassment: 0.1 });
  assert.equal((await moderate("hi", "in", { env: on, call: clean })).allowed, true);
  const bad: ModerationCall = async () => scores({ "sexual/minors": 0.9 });
  const v = await moderate("...", "out", { env: on, call: bad });
  assert.equal(v.allowed, false);
  assert.equal(v.category, "sexual");
});

test("moderate: FAIL-OPEN + alert on an endpoint error/timeout", async () => {
  const alerts: string[] = [];
  const boom: ModerationCall = async () => { throw new Error("This operation was aborted"); };
  const v = await moderate("hi", "in", { env: on, call: boom, alert: (m) => alerts.push(m) });
  assert.equal(v.allowed, true);
  assert.match(alerts.join(" "), /moderation call failed.*fail-open/);
});

test("moderate: FAIL-OPEN + alert on a misconfig (enabled but no OpenAI key)", async () => {
  const alerts: string[] = [];
  let called = false;
  const call: ModerationCall = async () => { called = true; return scores({}); };
  const v = await moderate("hi", "in", { env: { MODERATION_ENABLED: "1" }, call, alert: (m) => alerts.push(m) });
  assert.equal(v.allowed, true);
  assert.equal(called, false); // no call attempted without a key
  assert.match(alerts.join(" "), /MODERATION_OPENAI_API_KEY is unset/);
});

test("inboundBlockReply: category-specific, deterministic with a pick, unknown -> other", () => {
  assert.match(inboundBlockReply("profanity", 0), /clean/i);
  assert.notEqual(inboundBlockReply("harassment", 0), inboundBlockReply("profanity", 0));
  assert.equal(inboundBlockReply("nonsense", 0), inboundBlockReply("other", 0)); // unknown folds to other
  assert.equal(inboundBlockReply(undefined, 0), inboundBlockReply("other", 0));
});

test("outboundBlockNotice tells the agent to apologize, not resend", () => {
  const n = outboundBlockNotice("sexual/minors 0.91");
  assert.match(n, /do NOT resend/);
  assert.match(n, /can't help with that/i);
  assert.match(n, /sexual\/minors/);
});
