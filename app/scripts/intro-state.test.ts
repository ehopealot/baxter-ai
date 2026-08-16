// Tests for the first-contact intro latch (spec 2026-08-15-first-contact-intro-design
// §7): fail-open loads, idempotent marks that keep the two flags independent, the
// BAXTER_INTRO_GUIDANCE flag's value table, introDecision's group gating, and the
// rendered note. Mirrors home-state.test.ts's shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freshIntroState, loadIntroState, saveIntroState, markExplained, markCardSent,
  introGuidanceEnabled, introDecision, introNote, INTRO_EXPLAIN_COPY, INTRO_CARD_COPY,
} from "./intro-state.ts";

const latchPath = (): string => join(mkdtempSync(join(tmpdir(), "intro-")), "intro-state.json");

test("loadIntroState on a missing file is the fresh state (not a throw)", () => {
  assert.deepEqual(loadIntroState(latchPath()), freshIntroState());
});

test("a corrupt latch file falls back to fresh (fail-open: it must never block a reply)", () => {
  const p = latchPath();
  writeFileSync(p, "{ not json");
  assert.deepEqual(loadIntroState(p), freshIntroState());
  writeFileSync(p, JSON.stringify(3));
  assert.deepEqual(loadIntroState(p), freshIntroState(), "a non-object parse is also fresh");
});

test("an unreadable latch file (EACCES) also falls back to fresh -- total fail-open, unlike home-state", () => {
  const p = latchPath();
  writeFileSync(p, JSON.stringify({ explainedAt: "x" }));
  chmodSync(p, 0o000);
  try {
    assert.deepEqual(loadIntroState(p), freshIntroState());
  } finally {
    chmodSync(p, 0o644);
  }
});

test("markExplained persists an ISO timestamp and reads back; a second mark keeps the FIRST timestamp", () => {
  const p = latchPath();
  markExplained("2026-08-15T10:00:00.000Z", p);
  assert.equal(loadIntroState(p).explainedAt, "2026-08-15T10:00:00.000Z");
  markExplained("2026-08-15T11:00:00.000Z", p);
  assert.equal(loadIntroState(p).explainedAt, "2026-08-15T10:00:00.000Z", "an already-set flag never rewrites");
});

test("the two flags are independent: each mark preserves the other (one file, merged writes)", () => {
  const p = latchPath();
  markExplained("2026-08-15T10:00:00.000Z", p);
  assert.equal(loadIntroState(p).smsCardSentAt, undefined, "markExplained alone does not set the card flag");
  markCardSent("2026-08-15T12:00:00.000Z", p);
  const st = loadIntroState(p);
  assert.equal(st.explainedAt, "2026-08-15T10:00:00.000Z", "markCardSent preserves explainedAt");
  assert.equal(st.smsCardSentAt, "2026-08-15T12:00:00.000Z");
  // And the reverse order (card first, explanation later -- an SMS-first household
  // whose card went out before the explain mark, or an email-first one):
  const q = latchPath();
  markCardSent("2026-08-15T09:00:00.000Z", q);
  markExplained("2026-08-15T13:00:00.000Z", q);
  assert.deepEqual(loadIntroState(q), { smsCardSentAt: "2026-08-15T09:00:00.000Z", explainedAt: "2026-08-15T13:00:00.000Z" });
});

test("saveIntroState -> loadIntroState round-trips; markCardSent is idempotent too", () => {
  const p = latchPath();
  saveIntroState({ explainedAt: "a", smsCardSentAt: "b" }, p);
  assert.deepEqual(loadIntroState(p), { explainedAt: "a", smsCardSentAt: "b" });
  markCardSent("later", p);
  assert.equal(loadIntroState(p).smsCardSentAt, "b", "an already-set card flag never rewrites");
});

test("introGuidanceEnabled: unset/empty/0/false (any case/spacing) are OFF; anything else is ON", () => {
  const off: Array<NodeJS.ProcessEnv> = [
    {} as NodeJS.ProcessEnv,
    { BAXTER_INTRO_GUIDANCE: "" } as NodeJS.ProcessEnv,
    { BAXTER_INTRO_GUIDANCE: "0" } as NodeJS.ProcessEnv,
    { BAXTER_INTRO_GUIDANCE: "false" } as NodeJS.ProcessEnv,
    { BAXTER_INTRO_GUIDANCE: " FALSE " } as NodeJS.ProcessEnv,
    { BAXTER_INTRO_GUIDANCE: "  0\t" } as NodeJS.ProcessEnv,
  ];
  for (const env of off) assert.equal(introGuidanceEnabled(env), false, `OFF: ${JSON.stringify(env.BAXTER_INTRO_GUIDANCE)}`);
  for (const v of ["1", "true", "yes", "on", "anything-else"]) {
    assert.equal(introGuidanceEnabled({ BAXTER_INTRO_GUIDANCE: v } as NodeJS.ProcessEnv), true, `ON: ${v}`);
  }
});

test("introDecision: flag OFF -> both blocks off, no latch read (a corrupt latch cannot turn anything on)", () => {
  const p = latchPath();
  writeFileSync(p, "{ not json");
  assert.deepEqual(introDecision({} as NodeJS.ProcessEnv, false, p), { explain: false, card: false });
});

test("introDecision: flag ON + nothing set -> both blocks on for an SMS 1:1; a non-SMS surface (default) never sees the card", () => {
  const p = latchPath();
  const on = { BAXTER_INTRO_GUIDANCE: "1" } as NodeJS.ProcessEnv;
  assert.deepEqual(introDecision(on, true, p), { explain: true, card: true }, "an SMS 1:1 run renders both blocks");
  assert.deepEqual(introDecision(on, false, p), { explain: true, card: false }, "a non-SMS surface (mail/chat, the default) renders the shared block but NEVER the card");
  assert.deepEqual(introDecision(on), { explain: true, card: false }, "no second arg at all: same non-SMS shape");
});

test("introDecision: explainedAt set suppresses only the explain block (an email-first household still gets the card on its first SMS)", () => {
  const p = latchPath();
  markExplained("2026-08-15T10:00:00.000Z", p);
  const on = { BAXTER_INTRO_GUIDANCE: "1" } as NodeJS.ProcessEnv;
  assert.deepEqual(introDecision(on, true, p), { explain: false, card: true }, "SMS 1:1: card still due");
  markCardSent("2026-08-15T11:00:00.000Z", p);
  assert.deepEqual(introDecision(on, true, p), { explain: false, card: false });
});

test("introDecision: a corrupt latch under flag ON fails open to BOTH blocks (re-explain once, harmless)", () => {
  const p = latchPath();
  writeFileSync(p, "{ not json");
  assert.deepEqual(introDecision({ BAXTER_INTRO_GUIDANCE: "1" } as NodeJS.ProcessEnv, true, p), { explain: true, card: true });
});

test("introNote renders the spec copy verbatim, card as its own paragraph, and empty when nothing is due", () => {
  assert.equal(introNote({ explain: true, card: true }), `${INTRO_EXPLAIN_COPY}\n\n${INTRO_CARD_COPY}`);
  assert.equal(introNote({ explain: true, card: false }), INTRO_EXPLAIN_COPY);
  assert.equal(introNote({ explain: false, card: true }), INTRO_CARD_COPY);
  assert.equal(introNote({ explain: false, card: false }), "");
  assert.match(INTRO_EXPLAIN_COPY, /This is your first exchange with this household/);
  assert.match(INTRO_EXPLAIN_COPY, /settings page \(home\.bax\.bot\/settings\)/); // the conditional add-family hook
  assert.doesNotMatch(INTRO_EXPLAIN_COPY, /[—–]/); // no em/en dashes (operator preference)
  assert.match(INTRO_CARD_COPY, /`send-contact` CLI/);
});
