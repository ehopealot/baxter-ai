// Tests for feature-discovery (spec: docs/superpowers/specs/2026-08-19-cross-
// surface-home-link-discovery-design.md §2/§5/§6; plan task T3): the feature
// catalog keyed by intro-state's FEATURE_KEYS, the injectable-read discovery
// decision, the DISCOVERY_NOTE_MARKER-headed prompt note, MULTI-VALUED
// delivered-link matching (iterative terminal-punctuation stripping with the
// combined forms pinned), and the pure conclusion seam. Pure unit tests:
// explicit env objects and an injected read seam -- loadIntroState swallows
// every read failure internally, so only a spy can prove the flag-OFF no-read
// and the exactly-once properties (spec §1/§8, design.md:64).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FEATURE_KEYS, INTRO_CARD_COPY, INTRO_EXPLAIN_COPY, loadIntroState, type IntroState,
} from "./intro-state.ts";
import {
  DISCOVERY_LABELS, DISCOVERY_NOTE_MARKER, FEATURE_CATALOG, concludeDiscovery,
  deliveredLinkFeatures, discoveryDecision, discoveryNote,
  type DiscoveryDecision, type DiscoveryObservation, type FeatureKey, type RunOutcomeLite,
} from "./feature-discovery.ts";

const latchPath = (): string => join(mkdtempSync(join(tmpdir(), "discovery-")), "intro-state.json");
const ON = { BAXTER_INTRO_GUIDANCE: "1" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;
const DEFAULT = "https://home.bax.bot";
const COMPLETED: RunOutcomeLite = { failed: false, outOfTokens: false };

// A counting read seam: returns a fixed state and records every call's path.
function spyRead(state: IntroState): { read: (p: string) => IntroState; calls: string[] } {
  const calls: string[] = [];
  return { calls, read: (p) => { calls.push(p); return state; } };
}

// Compile-time exact-equality helper (same pin technique as intro-state.test.ts).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// ---------------------------------------------------------------------------
// Single source of truth: the key union is IMPORTED from intro-state.ts.
// ---------------------------------------------------------------------------

test("FeatureKey resolves from the intro-state import (no local re-definition of the union)", () => {
  // Compile-time pin: the re-exported type is EXACTLY intro-state's union -- an
  // Equal check, not assignability, so a duplicated or widened union fails here.
  const same: Equal<import("./feature-discovery.ts").FeatureKey, import("./intro-state.ts").FeatureKey> = true;
  assert.ok(same);
  // Runtime pin: the catalog is keyed by exactly FEATURE_KEYS, no more, no less.
  assert.deepEqual(Object.keys(FEATURE_CATALOG), [...FEATURE_KEYS]);
});

test("the catalog names the five qualifying CLIs; schedule-cli is narrowed to add/list/cancel ('groups' never qualifies)", () => {
  assert.equal(FEATURE_CATALOG.calendar.cli, "calendar-cli");
  assert.equal(FEATURE_CATALOG.checklists.cli, "checklist-cli");
  assert.equal(FEATURE_CATALOG.recipes.cli, "recipes-cli");
  assert.equal(FEATURE_CATALOG.collections.cli, "collections-cli");
  assert.equal(FEATURE_CATALOG.scheduled.cli, "schedule-cli");
  assert.deepEqual([...FEATURE_CATALOG.scheduled.verbs ?? []], ["add", "list", "cancel"]);
  assert.equal(FEATURE_CATALOG.calendar.verbs, undefined, "every other CLI qualifies on any verb");
});

// ---------------------------------------------------------------------------
// discoveryDecision: injectable read seam, pending computation, origin folding.
// ---------------------------------------------------------------------------

test("flag OFF: the injected read is NEVER called and pending is [] (no feature-state read)", () => {
  const p = latchPath();
  const seeded = spyRead({ featureIntroducedAt: { calendar: "2026-08-19T12:00:00Z" } });
  assert.deepEqual(discoveryDecision(OFF, p, seeded.read), { pending: [], origin: DEFAULT });
  assert.equal(seeded.calls.length, 0, "OFF performs no state read at all");
  for (const v of ["", "0", "false", " FALSE "]) {
    const spy = spyRead({});
    const d = discoveryDecision({ BAXTER_INTRO_GUIDANCE: v } as NodeJS.ProcessEnv, p, spy.read);
    assert.deepEqual(d.pending, [], `OFF value ${JSON.stringify(v)}`);
    assert.equal(spy.calls.length, 0);
  }
});

test("flag ON: the injected read is called EXACTLY ONCE, at the resolved path", () => {
  const p = latchPath();
  writeFileSync(p, JSON.stringify({ featureIntroducedAt: { calendar: "2026-08-19T12:00:00Z" } }));
  const spy = spyRead(loadIntroState(p));
  const d = discoveryDecision(ON, p, spy.read);
  assert.equal(spy.calls.length, 1, "exactly one read per decision");
  assert.equal(spy.calls[0], p, "the read hits the resolved latch path");
  assert.deepEqual(d.pending, ["checklists", "recipes", "collections", "scheduled"]);
});

test("an old two-field latch leaves all five features pending", () => {
  const p = latchPath();
  writeFileSync(p, JSON.stringify({ explainedAt: "2026-08-15T10:00:00.000Z", smsCardSentAt: "2026-08-15T12:00:00.000Z" }));
  assert.deepEqual(discoveryDecision(ON, p).pending, [...FEATURE_KEYS]);
});

test("featureIntroducedAt: null is an absent map: all five pending (design.md:60 'non-object' includes null)", () => {
  const p = latchPath();
  writeFileSync(p, JSON.stringify({ featureIntroducedAt: null }));
  assert.deepEqual(discoveryDecision(ON, p).pending, [...FEATURE_KEYS]);
});

test("primitive, boolean, and array maps likewise mean all five pending; unknown keys are ignored", () => {
  for (const bad of ["bad", true, [], ["x"]]) {
    const p = latchPath();
    writeFileSync(p, JSON.stringify({ featureIntroducedAt: bad, futureFeature: "2026-08-19T12:00:00Z" }));
    assert.deepEqual(discoveryDecision(ON, p).pending, [...FEATURE_KEYS], `map ${JSON.stringify(bad)} never blocks the decision`);
  }
});

test("a valid timestamp suppresses only its feature; invalid values stay pending while valid siblings suppress", () => {
  const p = latchPath();
  writeFileSync(p, JSON.stringify({
    featureIntroducedAt: {
      calendar: "2026-08-19T12:00:00+02:00", // offset form is valid (operator-approved grammar)
      checklists: "garbage",                  // invalid: stays pending
      recipes: "",                            // empty: stays pending
      futureFeature: "2026-08-19T12:00:00Z",  // unknown key: ignored
    },
  }));
  assert.deepEqual(discoveryDecision(ON, p).pending, ["checklists", "recipes", "collections", "scheduled"]);
});

test("the shared origin folds through: default when unset, custom when valid, null when set-but-invalid", () => {
  const p = latchPath();
  assert.equal(discoveryDecision(ON, p).origin, DEFAULT);
  assert.equal(
    discoveryDecision({ BAXTER_INTRO_GUIDANCE: "1", HOME_BASE_URL: "https://home.example.com/" } as NodeJS.ProcessEnv, p).origin,
    "https://home.example.com",
    "trailing slash trims via the shared validator",
  );
  const invalid = { BAXTER_INTRO_GUIDANCE: "1", HOME_BASE_URL: "https://home.example.com/prefix" } as NodeJS.ProcessEnv;
  assert.equal(discoveryDecision(invalid, p).origin, null, "invalid override: null, never a silent default fallback");
  // The invalid-origin decision still reads state (only the note/matching fail open):
  assert.deepEqual(discoveryDecision(invalid, p).pending, [...FEATURE_KEYS], "a fresh latch under an invalid origin is still all-pending");
  assert.equal(discoveryDecision(OFF, p).origin, DEFAULT, "OFF folds the origin too -- it just reads nothing");
});

// ---------------------------------------------------------------------------
// discoveryNote: the DISCOVERY_NOTE_MARKER pin, exact pending list, hygiene.
// ---------------------------------------------------------------------------

test("DISCOVERY_NOTE_MARKER: every non-empty discoveryNote output BEGINS with it; empty notes are exactly ''", () => {
  const dAll: DiscoveryDecision = { pending: [...FEATURE_KEYS], origin: DEFAULT };
  const dOne: DiscoveryDecision = { pending: ["scheduled"], origin: DEFAULT };
  const dCustom: DiscoveryDecision = { pending: ["calendar"], origin: "https://home.example.com" };
  for (const d of [dAll, dOne, dCustom]) {
    const note = discoveryNote(d);
    assert.notEqual(note, "");
    assert.ok(note.startsWith(DISCOVERY_NOTE_MARKER), "every non-empty note begins with the exported marker");
  }
  assert.equal(discoveryNote({ pending: [], origin: DEFAULT }), "", "none pending -> ''");
  assert.equal(discoveryNote({ pending: ["calendar"], origin: null }), "", "invalid origin -> '' (the note is omitted, never rendered against an unvalidated origin)");
  assert.ok(DISCOVERY_NOTE_MARKER.length > 0 && !DISCOVERY_NOTE_MARKER.endsWith(" "), "the marker is a real fixed sentence");
});

test("the marker text appears in none of intro-state.ts's exported copy constants (T9's chat-exclusion key)", () => {
  assert.ok(!INTRO_EXPLAIN_COPY.includes(DISCOVERY_NOTE_MARKER), "not in INTRO_EXPLAIN_COPY");
  assert.ok(!INTRO_CARD_COPY.includes(DISCOVERY_NOTE_MARKER), "not in INTRO_CARD_COPY");
});

test("discoveryNote lists exactly the pending features' labels and full URL rules, rendered from decision.origin", () => {
  const note = discoveryNote({ pending: [...FEATURE_KEYS], origin: DEFAULT });
  for (const k of FEATURE_KEYS) {
    const e = FEATURE_CATALOG[k];
    assert.ok(note.includes(`${DISCOVERY_LABELS[k]}: `), `lists the ${k} label`);
    assert.ok(note.includes(`${DEFAULT}${e.preferredPath}`), `${k} preferred destination rule`);
    assert.ok(note.includes(`${DEFAULT}${e.fallbackPath}`), `${k} fallback destination rule`);
  }
  // Exactly the pending ones: a partial decision renders only its own entries.
  const partial = discoveryNote({ pending: ["calendar", "recipes"], origin: DEFAULT });
  assert.ok(partial.startsWith(DISCOVERY_NOTE_MARKER));
  assert.ok(partial.includes(`${DISCOVERY_LABELS.calendar}: ${DEFAULT}/calendar`));
  assert.ok(partial.includes(`${DEFAULT}/r/<recipe-slug>`));
  for (const absent of ["checklists", "collections", "scheduled tasks"] as const) {
    assert.ok(!partial.includes(`${absent}:`), `non-pending label ${absent} absent`);
  }
  assert.ok(!partial.includes(`${DEFAULT}/l/`), "non-pending checklists route absent");
  assert.ok(!partial.includes(`${DEFAULT}/collections`), "non-pending collections route absent");
  assert.ok(!partial.includes(`${DEFAULT}/scheduled`), "non-pending scheduled route absent");
  // Rendered from decision.origin, never from the default when an override is set.
  const custom = discoveryNote({ pending: ["calendar"], origin: "https://home.example.com" });
  assert.ok(custom.includes("https://home.example.com/calendar"));
  assert.ok(!custom.includes(DEFAULT), "no default-origin URL leaks into an overridden note");
});

test("note copy hygiene: link-cli preference present, no internal-state wording, no em/en dashes, one paragraph", () => {
  const note = discoveryNote({ pending: [...FEATURE_KEYS], origin: DEFAULT });
  assert.match(note, /link-cli/, "mentions the object-URL preference");
  assert.match(note, /answer the person's actual request first/i, "answer-first contract");
  assert.match(note, /only features this reply actually used successfully/i, "mention-only-used contract");
  assert.match(note, /every relevant one when several were used/i, "multi-feature contract");
  assert.ok(!note.includes("\n"), "single paragraph: \\n\\n-safe for slot embedding");
  assert.doesNotMatch(note, /[—–]/, "no em/en dashes (operator preference)");
  assert.doesNotMatch(
    note,
    /\b(pending|introduced|introduce|latch|onboarding|tracking|tracked|featureIntroducedAt|intro-state|state)\b/i,
    "no internal-state wording",
  );
});

// ---------------------------------------------------------------------------
// deliveredLinkFeatures: MULTI-VALUED matching over parsed URLs.
// ---------------------------------------------------------------------------

test("accepts every preferred and fallback route, with query strings and fragments riding along", () => {
  const cases: Array<[string, FeatureKey[]]> = [
    ["https://home.bax.bot/calendar", ["calendar"]],
    ["https://home.bax.bot/calendar?utm=mail#today", ["calendar"]],
    ["https://home.bax.bot/calendar?", ["calendar"]], // a bare trailing '?' strips before parsing
    ["https://home.bax.bot/", ["checklists"]],
    ["https://home.bax.bot/?x=1", ["checklists"]],
    ["https://home.bax.bot/l/groceries", ["checklists"]],
    ["https://home.bax.bot/l/groceries?tab=open#items", ["checklists"]],
    ["https://home.bax.bot/recipes", ["recipes"]],
    ["https://home.bax.bot/recipes#featured", ["recipes"]],
    ["https://home.bax.bot/r/weeknight-pasta", ["recipes"]],
    ["https://home.bax.bot/r/weeknight-pasta?src=mail", ["recipes"]],
    ["https://home.bax.bot/collections", ["collections"]],
    ["https://home.bax.bot/c/trip-ideas", ["collections"]],
    ["https://home.bax.bot/c/trip-ideas#list", ["collections"]],
    ["https://home.bax.bot/scheduled", ["scheduled"]],
    ["https://home.bax.bot/scheduled?view=week", ["scheduled"]],
  ];
  for (const [text, want] of cases) assert.deepEqual(deliveredLinkFeatures(text, DEFAULT), want, text);
});

test("single trailing prose punctuation is stripped from candidates before parsing", () => {
  assert.deepEqual(deliveredLinkFeatures("See https://home.bax.bot/calendar.", DEFAULT), ["calendar"]);
  assert.deepEqual(deliveredLinkFeatures("Saved it: https://home.bax.bot/r/weeknight-pasta.", DEFAULT), ["recipes"]);
  assert.deepEqual(deliveredLinkFeatures("Your calendar: https://home.bax.bot/calendar,", DEFAULT), ["calendar"]);
  assert.deepEqual(deliveredLinkFeatures("Done! https://home.bax.bot/scheduled!", DEFAULT), ["scheduled"]);
  assert.deepEqual(deliveredLinkFeatures("See the collection (https://home.bax.bot/collections);", DEFAULT), ["collections"]);
  assert.deepEqual(deliveredLinkFeatures("markdown [calendar](https://home.bax.bot/calendar)", DEFAULT), ["calendar"]);
});

test("COMBINED terminal punctuation strips ITERATIVELY to a fixpoint (a one-pass single-character strip fails exactly these)", () => {
  assert.deepEqual(deliveredLinkFeatures("(see https://home.bax.bot/calendar).", DEFAULT), ["calendar"], "strip ')' then '.'");
  assert.deepEqual(deliveredLinkFeatures('see "https://home.bax.bot/r/weeknight-pasta".', DEFAULT), ["recipes"], "closing quote then period");
  assert.deepEqual(deliveredLinkFeatures('see "https://home.bax.bot/scheduled".', DEFAULT), ["scheduled"], "quote+period on a third route");
  assert.deepEqual(deliveredLinkFeatures("link (https://home.bax.bot/calendar).", DEFAULT), ["calendar"]);
});

test("a BALANCED trailing ')' belongs to the URL and is kept (only an unbalanced one strips)", () => {
  // Balanced parens survive stripping, so the path keeps them and matches no route.
  assert.deepEqual(deliveredLinkFeatures("https://home.bax.bot/calendar(x)", DEFAULT), []);
});

test("MULTI-VALUED: one text carrying BOTH valid links returns BOTH keys -- never a first match", () => {
  const both = "Your calendar is at https://home.bax.bot/calendar and the recipe at https://home.bax.bot/r/weeknight-pasta.";
  assert.deepEqual(deliveredLinkFeatures(both, DEFAULT), ["calendar", "recipes"]);
  const all = "https://home.bax.bot/ https://home.bax.bot/recipes https://home.bax.bot/c/x https://home.bax.bot/scheduled https://home.bax.bot/calendar";
  assert.deepEqual(deliveredLinkFeatures(all, DEFAULT), [...FEATURE_KEYS]);
  // Dedup: the same link twice yields its key once.
  assert.deepEqual(deliveredLinkFeatures("https://home.bax.bot/calendar and https://home.bax.bot/calendar", DEFAULT), ["calendar"]);
});

test("lookalike hosts, unrelated paths, route-prefix confusion, and scheme-less text never match", () => {
  assert.deepEqual(deliveredLinkFeatures("https://home.bax.bot.evil.com/calendar", DEFAULT), []);
  assert.deepEqual(deliveredLinkFeatures("https://home-bax.bot/calendar", DEFAULT), []);
  assert.deepEqual(deliveredLinkFeatures("https://evil.example.com/calendar", DEFAULT), []);
  assert.deepEqual(deliveredLinkFeatures("https://home.bax.bot/settings", DEFAULT), []);
  assert.deepEqual(deliveredLinkFeatures("https://home.bax.bot/chats/wc-1", DEFAULT), []);
  assert.deepEqual(deliveredLinkFeatures("https://home.bax.bot/calendar-evil", DEFAULT), [], "route-prefix confusion");
  assert.deepEqual(deliveredLinkFeatures("https://home.bax.bot/scheduled-tasks", DEFAULT), []);
  assert.deepEqual(deliveredLinkFeatures("https://home.bax.bot/l/", DEFAULT), [], "empty slug does not match");
  assert.deepEqual(deliveredLinkFeatures("https://home.bax.bot/l/a/b", DEFAULT), [], "nested slug does not match");
  assert.deepEqual(deliveredLinkFeatures("no links here at all", DEFAULT), []);
  assert.deepEqual(deliveredLinkFeatures("visit home.bax.bot/calendar", DEFAULT), [], "scheme-less text is not a candidate");
  assert.deepEqual(deliveredLinkFeatures("ftp://home.bax.bot/calendar", DEFAULT), [], "non-http scheme is not a candidate");
});

test("origin equality is exact: a valid link matches only its own origin", () => {
  assert.deepEqual(deliveredLinkFeatures("https://home.example.com/calendar", "https://home.example.com"), ["calendar"]);
  assert.deepEqual(deliveredLinkFeatures("https://home.bax.bot/calendar", "https://home.example.com"), []);
});

// ---------------------------------------------------------------------------
// concludeDiscovery: the pure per-turn conclusion seam (spec §6).
// ---------------------------------------------------------------------------

test("returns pending INTERSECT successful interactions INTERSECT links delivered to the triggering target", () => {
  const decision: DiscoveryDecision = { pending: ["calendar", "recipes", "scheduled"], origin: DEFAULT };
  const obs: DiscoveryObservation = {
    interactions: ["calendar", "recipes"],
    deliveries: [{ target: "th-1", text: "See https://home.bax.bot/calendar and https://home.bax.bot/r/weeknight-pasta." }],
  };
  assert.deepEqual(concludeDiscovery(decision, obs, "th-1", COMPLETED), ["calendar", "recipes"]);
});

test("DECISIVE DUAL-LINK: one delivery carrying BOTH links completes BOTH pending features; one link completes only that one", () => {
  const decision: DiscoveryDecision = { pending: ["calendar", "recipes"], origin: DEFAULT };
  const interactions: FeatureKey[] = ["calendar", "recipes"];
  const both = { target: "th-1", text: "https://home.bax.bot/calendar and https://home.bax.bot/r/weeknight-pasta" };
  assert.deepEqual(concludeDiscovery(decision, { interactions, deliveries: [both] }, "th-1", COMPLETED), ["calendar", "recipes"]);
  const one = { target: "th-1", text: "https://home.bax.bot/r/weeknight-pasta" };
  assert.deepEqual(concludeDiscovery(decision, { interactions, deliveries: [one] }, "th-1", COMPLETED), ["recipes"]);
});

test("the delivery side is the UNION over successful deliveries to the triggering target", () => {
  const decision: DiscoveryDecision = { pending: ["calendar", "recipes"], origin: DEFAULT };
  const obs: DiscoveryObservation = {
    interactions: ["calendar", "recipes"],
    deliveries: [
      { target: "th-1", text: "https://home.bax.bot/calendar" },
      { target: "th-1", text: "https://home.bax.bot/r/weeknight-pasta" },
    ],
  };
  assert.deepEqual(concludeDiscovery(decision, obs, "th-1", COMPLETED), ["calendar", "recipes"]);
});

test("INVALID-ORIGIN: origin null matches nothing, even for an otherwise-valid DEFAULT-origin link (spec §3)", () => {
  const decision: DiscoveryDecision = { pending: ["calendar"], origin: null };
  const obs: DiscoveryObservation = {
    interactions: ["calendar"],
    deliveries: [{ target: "th-1", text: "See https://home.bax.bot/calendar." }],
  };
  assert.deepEqual(concludeDiscovery(decision, obs, "th-1", COMPLETED), []);
});

test("empty mark set: failed run, token wall, wrong target, missing link, wrong-route link, no interaction, not pending", () => {
  const decision: DiscoveryDecision = { pending: ["calendar", "recipes"], origin: DEFAULT };
  const perfect: DiscoveryObservation = {
    interactions: ["calendar"],
    deliveries: [{ target: "th-1", text: "https://home.bax.bot/calendar" }],
  };
  assert.deepEqual(concludeDiscovery(decision, perfect, "th-1", { failed: true, outOfTokens: false }), [], "failed run");
  assert.deepEqual(concludeDiscovery(decision, perfect, "th-1", { failed: false, outOfTokens: true }), [], "token wall");
  assert.deepEqual(concludeDiscovery(decision, perfect, "th-2", COMPLETED), [], "delivery to a different target (wrong thread/number/group) never satisfies this run");
  assert.deepEqual(concludeDiscovery(decision, { interactions: ["calendar"], deliveries: [] }, "th-1", COMPLETED), [], "interaction but no delivered link");
  assert.deepEqual(concludeDiscovery(decision, { interactions: ["calendar"], deliveries: [{ target: "th-1", text: "no link in this reply" }] }, "th-1", COMPLETED), [], "missing link");
  assert.deepEqual(concludeDiscovery(decision, { interactions: ["calendar"], deliveries: [{ target: "th-1", text: "https://home.bax.bot/settings" }] }, "th-1", COMPLETED), [], "wrong-route link");
  assert.deepEqual(concludeDiscovery(decision, { interactions: [], deliveries: [{ target: "th-1", text: "https://home.bax.bot/calendar" }] }, "th-1", COMPLETED), [], "delivered but never successfully used");
  assert.deepEqual(concludeDiscovery(decision, { interactions: ["collections"], deliveries: [{ target: "th-1", text: "https://home.bax.bot/c/trip-ideas" }] }, "th-1", COMPLETED), [], "interaction with a feature that is not pending");
});
