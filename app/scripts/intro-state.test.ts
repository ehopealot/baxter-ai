// Tests for the first-contact intro latch (spec 2026-08-15-first-contact-intro-design
// §7): fail-open loads, idempotent marks that keep the two flags independent, the
// BAXTER_INTRO_GUIDANCE flag's value table, introDecision's group gating, and the
// rendered note. Mirrors home-state.test.ts's shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freshIntroState, loadIntroState, saveIntroState, markExplained, markCardSent,
  introGuidanceEnabled, introDecision, introNote, INTRO_EXPLAIN_COPY, INTRO_CARD_COPY,
  FEATURE_KEYS, isValidIntroTimestamp, markFeaturesIntroduced, type FeatureKey, type IntroState,
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
  assert.deepEqual(introDecision(on, undefined, p), { explain: true, card: false }, "an omitted SMS argument keeps the non-SMS shape with the fixture latch");
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
  assert.match(INTRO_EXPLAIN_COPY, /settings page at https:\/\/home\.bax\.bot\/settings/); // conditional add-family hook, full URL so it autolinks
  assert.doesNotMatch(INTRO_EXPLAIN_COPY, /[—–]/); // no em/en dashes (operator preference)
  assert.match(INTRO_CARD_COPY, /`send-contact` CLI/);
});

// ---------------------------------------------------------------------------
// T2 (spec: docs/superpowers/specs/2026-08-19-cross-surface-home-link-discovery-
// design.md §1; plan task T2): FEATURE_KEYS as the single feature-key source of
// truth, the featureIntroducedAt map, the operator-approved ISO timestamp
// validity grammar (2026-08-20), and the env-consistent observable
// markFeaturesIntroduced.
// ---------------------------------------------------------------------------

// (A) FEATURE_KEYS is the single source of the feature-key union (FeatureKey
// derives from it; nothing else in core/app/scripts may redefine the list).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
test("FEATURE_KEYS exports exactly the five feature keys and FeatureKey derives from it", () => {
  assert.deepEqual([...FEATURE_KEYS], ["calendar", "checklists", "recipes", "collections", "scheduled"]);
  // Compile-time derivation pin: FeatureKey must be EXACTLY the element union of
  // FEATURE_KEYS, not merely compatible with it -- a plain assignability check
  // would still pass if the union were manually duplicated or widened to string.
  // Referenced below so the tsc gate cannot drop it as an unused constant.
  const featureKeyDerives: Equal<FeatureKey, (typeof FEATURE_KEYS)[number]> = true;
  assert.ok(featureKeyDerives);
});

// (B) BASE VALIDITY: lexical ISO shape AND finite parse AND calendar-valid
// components. This group fails against a Date.parse-finite-only implementation
// ('2026-02-31T00:00:00Z' parses FINITE on Node v24 but rolls to 2026-03-03;
// 'March 1, 2026' parses finite but is not lexically ISO) -- the component and
// lexical checks are genuinely required, not decorative.
test("isValidIntroTimestamp BASE VALIDITY: accepts toISOString output and offset forms; rejects non-ISO, rolled, and overflow literals", () => {
  const valid: string[] = [
    new Date().toISOString(),
    "2026-08-19T12:00:00Z",      // 0-digit-ms truncation
    "2026-08-19T12:00:00.1Z",    // 1-digit-ms truncation
    "2026-08-19T12:00:00.25Z",   // 2-digit-ms truncation
    "2026-08-19T12:00:00+02:00", // numeric offset
    "2026-08-19T12:00:00+0200",  // colon-less numeric offset
    "2024-02-29T12:00:00Z",      // valid leap day
  ];
  for (const v of valid) assert.equal(isValidIntroTimestamp(v), true, `valid: ${v}`);
  const invalid: unknown[] = [
    "",                           // empty
    "March 1, 2026",              // finite parse, non-ISO lexical shape
    "2026-02-31T00:00:00Z",      // finite on Node v24 but rolls to 2026-03-03
    "2026-13-01T00:00:00Z",      // month overflow
    "2023-02-29T12:00:00Z",      // non-leap year
    "2026-08-19T12:60:00Z",      // minute overflow
    "2026-08-19T12:00:60Z",      // second overflow
    "2026-08-19T12:00:00+24:00", // offset hour overflow
    "2026-08-19T12:00:00+23:60", // offset minute overflow
    undefined,
    null,
    1724073600000,
  ];
  for (const v of invalid) assert.equal(isValidIntroTimestamp(v), false, `invalid: ${JSON.stringify(v) ?? String(v)}`);
});

// (C) BOUNDARY (operator-approved broadened set, 2026-08-20): date-only,
// seconds-optional datetimes, the exact 24:00 end-of-day, and colon-less offsets
// are VALID; timezone-less date-times, non-exact 24:00 variants, and date-only
// rollovers are INVALID.
test("isValidIntroTimestamp BOUNDARY (operator-approved broadened grammar, 2026-08-20)", () => {
  const valid = [
    "2026-08-19",           // date-only (the sole timezone-exempt form)
    "2024-02-29",           // valid leap date-only
    "2026-08-19T12:00Z",    // seconds-optional
    "2026-08-19T24:00:00Z", // exact end-of-day
    "2026-08-19T24:00Z",    // bare exact end-of-day
    "2026-08-19T24:00:00.000Z", // exact end-of-day, all-zero fraction
    "2026-08-19T12:00:00+0200", // colon-less offset
  ];
  for (const v of valid) assert.equal(isValidIntroTimestamp(v), true, `boundary valid: ${v}`);
  const invalid = [
    "2026-08-19T12:00",    // timezone-less date-time
    "2026-08-19T12:00:00", // timezone-less date-time
    "2026-08-19T24:30:00Z", // non-exact 24:00 variant
    "2026-08-19T24:00:01Z", // non-exact 24:00 variant
    "2026-08-19T24:00:00.1Z", // a non-zero fraction breaks the exact-24:00 rule
    "2026-02-30",          // date-only rollover
    "2023-02-29",          // non-leap date-only rollover
  ];
  for (const v of invalid) assert.equal(isValidIntroTimestamp(v), false, `boundary invalid: ${v}`);
});

// (D) Map behavior: old files, verbatim preservation, and fail-open over every
// malformed map shape.
test("an old two-field latch loads with featureIntroducedAt undefined", () => {
  const p = latchPath();
  saveIntroState({ explainedAt: "2026-08-15T10:00:00.000Z", smsCardSentAt: "2026-08-15T12:00:00.000Z" }, p);
  assert.equal(loadIntroState(p).featureIntroducedAt, undefined, "all five features stay pending downstream");
});

test("a valid offset-form timestamp suppresses its feature; a re-mark preserves it VERBATIM with ZERO writes", () => {
  const p = latchPath();
  writeFileSync(p, JSON.stringify({ featureIntroducedAt: { calendar: "2026-08-19T12:00:00+02:00" } }));
  let writes = 0;
  markFeaturesIntroduced(["calendar"], process.env, "2026-08-20T09:00:00.000Z", p, { write: () => { writes++; } });
  assert.equal(writes, 0, "an already-valid timestamp never rewrites (spec §1: existing timestamps win)");
  assert.equal(loadIntroState(p).featureIntroducedAt?.calendar, "2026-08-19T12:00:00+02:00", "persisted offset string unchanged");
});

test("an invalid value for one key is overwritten by a valid mark while valid siblings stay untouched", () => {
  const p = latchPath();
  writeFileSync(p, JSON.stringify({ featureIntroducedAt: { calendar: "2026-08-19T12:00:00+02:00", recipes: "garbage" } }));
  markFeaturesIntroduced(["calendar", "recipes"], process.env, "2026-08-20T09:00:00.000Z", p);
  const m = loadIntroState(p).featureIntroducedAt;
  assert.equal(m?.calendar, "2026-08-19T12:00:00+02:00", "valid sibling preserved verbatim");
  assert.equal(m?.recipes, "2026-08-20T09:00:00.000Z", "invalid value overwritten with the canonical `at`");
});

test("featureIntroducedAt: null is treated as an absent map: never blocks a read or write; a mark builds a proper object map", () => {
  const p = latchPath();
  writeFileSync(p, JSON.stringify({ featureIntroducedAt: null }));
  assert.equal(loadIntroState(p).featureIntroducedAt, null, "loadIntroState adds no validation (design.md:60): null rides through");
  markFeaturesIntroduced(["calendar", "scheduled"], process.env, "2026-08-20T09:00:00.000Z", p);
  const m = loadIntroState(p).featureIntroducedAt;
  assert.ok(m !== null && typeof m === "object" && !Array.isArray(m), "the merge treats null as absent and writes a proper object map");
  assert.equal(m?.calendar, "2026-08-20T09:00:00.000Z");
  assert.equal(m?.scheduled, "2026-08-20T09:00:00.000Z");
});

test("primitive, array, and corrupt featureIntroducedAt maps never block a read or a write", () => {
  for (const badMap of ["bad", true, [], ["x"]]) {
    const p = latchPath();
    writeFileSync(p, JSON.stringify({ featureIntroducedAt: badMap }));
    markFeaturesIntroduced(["checklists"], process.env, "2026-08-20T09:00:00.000Z", p);
    const m = loadIntroState(p).featureIntroducedAt;
    assert.ok(m !== null && typeof m === "object" && !Array.isArray(m) && typeof (m as Record<string, unknown>).checklists === "string",
      `merge over ${JSON.stringify(badMap)} wrote a proper map`);
  }
  // A wholly corrupt file: loadIntroState fails open to fresh, the mark writes over fresh.
  const corrupt = latchPath();
  writeFileSync(corrupt, "{ not json");
  markFeaturesIntroduced(["checklists"], process.env, "2026-08-20T09:00:00.000Z", corrupt);
  assert.equal(loadIntroState(corrupt).featureIntroducedAt?.checklists, "2026-08-20T09:00:00.000Z");
});

// (E) ENV-CONSISTENCY: the default path derives from the EXPLICIT env parameter
// (introStatePath(env)), mirroring introDecision -- NOT from bare
// introStatePath()/process.env like the pre-existing markExplained/markCardSent.
test("markFeaturesIntroduced's default path honors the INJECTED env: reads and writes fileA, never creates fileB", () => {
  const fileA = join(mkdtempSync(join(tmpdir(), "intro-a")), "intro-state.json");
  const fileB = join(mkdtempSync(join(tmpdir(), "intro-b")), "intro-state.json");
  const prev = process.env.INTRO_STATE_PATH_OVERRIDE;
  process.env.INTRO_STATE_PATH_OVERRIDE = fileB;
  try {
    const env = { INTRO_STATE_PATH_OVERRIDE: fileA } as NodeJS.ProcessEnv;
    markFeaturesIntroduced(["calendar"], env, "2026-08-20T09:00:00.000Z");
    assert.equal(loadIntroState(fileA).featureIntroducedAt?.calendar, "2026-08-20T09:00:00.000Z",
      "the default path resolved from the injected env -- the same file introDecision(env) reads");
    assert.equal(existsSync(fileB), false, "fileB (process.env override) is never created or modified");
  } finally {
    if (prev === undefined) delete process.env.INTRO_STATE_PATH_OVERRIDE;
    else process.env.INTRO_STATE_PATH_OVERRIDE = prev;
  }
});

// (F) Injected io spies: exact write counts, whole-set atomicity, preservation.
test("markFeaturesIntroduced over a fresh latch performs EXACTLY ONE read and ONE write carrying BOTH timestamps", () => {
  const p = latchPath();
  const reads: string[] = [];
  const writes: Array<{ state: IntroState; path: string }> = [];
  markFeaturesIntroduced(["calendar", "checklists"], process.env, "2026-08-20T09:00:00.000Z", p, {
    read: (path) => { reads.push(path); return loadIntroState(path); },
    write: (state, path) => { writes.push({ state, path }); },
  });
  assert.equal(reads.length, 1, "exactly one synchronous read");
  assert.equal(writes.length, 1, "a single write for the whole set");
  assert.equal(writes[0]?.path, p);
  assert.equal(writes[0]?.state.featureIntroducedAt?.calendar, "2026-08-20T09:00:00.000Z");
  assert.equal(writes[0]?.state.featureIntroducedAt?.checklists, "2026-08-20T09:00:00.000Z");
});

test("re-marking two already-valid keys performs ZERO writes and leaves the persisted originals intact", () => {
  const p = latchPath();
  writeFileSync(p, JSON.stringify({
    featureIntroducedAt: { calendar: "2026-08-18T12:00:00+02:00", checklists: "2026-08-18T12:00:00.250Z" },
  }));
  let writes = 0;
  markFeaturesIntroduced(["calendar", "checklists"], process.env, "2026-08-20T09:00:00.000Z", p, { write: () => { writes++; } });
  assert.equal(writes, 0);
  const m = loadIntroState(p).featureIntroducedAt;
  assert.equal(m?.calendar, "2026-08-18T12:00:00+02:00");
  assert.equal(m?.checklists, "2026-08-18T12:00:00.250Z");
});

test("unknown feature keys and unknown top-level fields survive a mark", () => {
  const p = latchPath();
  writeFileSync(p, JSON.stringify({
    explainedAt: "2026-08-15T10:00:00.000Z",
    customField: "keep-me",
    featureIntroducedAt: { calendar: "2026-08-18T12:00:00Z", futureFeature: "2026-08-18T13:00:00Z" },
  }));
  markFeaturesIntroduced(["recipes"], process.env, "2026-08-20T09:00:00.000Z", p);
  const st = loadIntroState(p);
  assert.equal((st as { customField?: string }).customField, "keep-me", "unknown top-level field survives");
  assert.equal(st.explainedAt, "2026-08-15T10:00:00.000Z");
  assert.equal(st.featureIntroducedAt?.calendar, "2026-08-18T12:00:00Z", "untouched known key survives");
  assert.equal((st.featureIntroducedAt as Record<string, string | undefined>).futureFeature, "2026-08-18T13:00:00Z", "unknown feature key survives");
  assert.equal(st.featureIntroducedAt?.recipes, "2026-08-20T09:00:00.000Z", "the newly introduced feature is written");
});

test("markFeaturesIntroduced with default io persists through the real file; unrequested features stay pending", () => {
  const p = latchPath();
  markFeaturesIntroduced(["recipes", "scheduled"], process.env, "2026-08-20T10:00:00.000Z", p);
  const m = loadIntroState(p).featureIntroducedAt;
  assert.equal(m?.recipes, "2026-08-20T10:00:00.000Z");
  assert.equal(m?.scheduled, "2026-08-20T10:00:00.000Z");
  assert.equal(m?.calendar, undefined, "unrequested features stay pending");
});

// (G) every pre-existing intro-state test above stays green unchanged -- proven
// by the full-file suite run, not by any edit to them.
