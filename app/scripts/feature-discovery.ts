// feature-discovery: the cross-surface Home link discovery POLICY module (spec:
// docs/superpowers/specs/2026-08-19-cross-surface-home-link-discovery-design.md
// §2/§5/§6; plan task T3). No direct fs/network/harness dependency here; the
// pure helpers are pure, while discoveryDecision reads intro state solely
// through its injectable read seam (default loadIntroState). The surface
// factories (mail-bot/sms-bot, T7/T8) and the run observer (T6) consume it:
//
//  - FEATURE_CATALOG    the five-feature catalog: qualifying CLI (schedule-cli
//                       narrowed to add/list/cancel; 'groups' is a delivery-
//                       target lookup, never an interaction), note label,
//                       preferred/fallback destination rules for the note, and
//                       the §5 delivered-link route family for the same feature.
//  - discoveryDecision  the immutable per-run decision (pending keys + shared
//                       origin), computed through an INJECTABLE read seam.
//  - discoveryNote      the static prompt note, headed by DISCOVERY_NOTE_MARKER.
//  - deliveredLinkFeatures  MULTI-VALUED delivered-link matching over parsed
//                       URLs: one reply text can deliver SEVERAL features'
//                       links, so this returns EVERY matched feature, never a
//                       first match (spec Approved-decisions / §8).
//  - concludeDiscovery  the pure §6 conclusion seam: pending INTERSECT
//                       successful interactions INTERSECT delivered-to-the-
//                       triggering-target. Reads no state files.
//
// FeatureKey/FEATURE_KEYS live ONLY in intro-state.ts (its FEATURE_KEYS export
// is the one frozen feature-key list repo-wide); this module imports the type
// and re-exports it for downstream ergonomics, never redefining the union.
// markFeaturesIntroduced is imported by the surface factories from
// intro-state.ts directly.
import { validatedHomeOrigin } from "./home-origin.ts";
import {
  FEATURE_KEYS, introGuidanceEnabled, introStatePath, isValidIntroTimestamp, loadIntroState,
  type FeatureKey, type IntroState,
} from "./intro-state.ts";

export type { FeatureKey };

// The feature catalog (spec "Feature catalog and destinations"). preferredPath/
// fallbackPath are the NOTE-rendering destination rules -- a <slug> placeholder
// stands for the canonical object slug link-cli resolves; matchesPath is the §5
// route family (exact paths, query/fragment ignored, no prefix tolerance) for
// the same feature, so the note and link matching can never drift apart.
export interface FeatureCatalogEntry {
  readonly cli: string;
  /** Qualifying first verbs; set only where a CLI has non-interaction verbs (schedule-cli). */
  readonly verbs?: readonly string[];
  readonly label: string;
  readonly preferredPath: string;
  readonly fallbackPath: string;
  readonly matchesPath: (path: string) => boolean;
}

export const FEATURE_CATALOG: Readonly<Record<FeatureKey, FeatureCatalogEntry>> = {
  calendar: {
    cli: "calendar-cli",
    label: "calendar",
    preferredPath: "/calendar",
    fallbackPath: "/calendar",
    matchesPath: (p) => p === "/calendar",
  },
  checklists: {
    cli: "checklist-cli",
    label: "checklists",
    preferredPath: "/l/<list-slug>",
    fallbackPath: "/", // the Home root is the checklists fallback
    matchesPath: (p) => p === "/" || /^\/l\/[^/]+$/.test(p),
  },
  recipes: {
    cli: "recipes-cli",
    label: "recipes",
    preferredPath: "/r/<recipe-slug>",
    fallbackPath: "/recipes",
    matchesPath: (p) => p === "/recipes" || /^\/r\/[^/]+$/.test(p),
  },
  collections: {
    cli: "collections-cli",
    label: "collections",
    preferredPath: "/c/<collection-slug>",
    fallbackPath: "/collections",
    matchesPath: (p) => p === "/collections" || /^\/c\/[^/]+$/.test(p),
  },
  scheduled: {
    cli: "schedule-cli",
    verbs: ["add", "list", "cancel"],
    label: "scheduled tasks",
    preferredPath: "/scheduled",
    fallbackPath: "/scheduled",
    matchesPath: (p) => p === "/scheduled",
  },
};

// Note labels, derived from the catalog (one source), exported for tests/pins.
export const DISCOVERY_LABELS: Readonly<Record<FeatureKey, string>> = (() => {
  const labels = {} as Record<FeatureKey, string>;
  for (const k of FEATURE_KEYS) labels[k] = FEATURE_CATALOG[k].label;
  return labels;
})();

// The immutable per-run decision, captured ONCE at dispatch and shared by prompt
// construction and the post-run conclusion (spec §2: prompt and conclusion use
// ONE captured decision, no independent re-read). origin === null means
// HOME_BASE_URL is SET but invalid: the note is omitted, no delivered URL can
// match, nothing is marked -- every feature stays pending (spec §3 fail-open).
export interface DiscoveryDecision {
  readonly pending: readonly FeatureKey[];
  readonly origin: string | null;
}

// The `read` seam defaults to loadIntroState, which fails open to fresh on every
// read problem -- env/path-only tests cannot distinguish "no read" from "failed
// read", so the flag-OFF no-read and the exactly-once properties are only
// provable through a spy passed here (or the factories' discoveryDecision dep).
export function discoveryDecision(
  env: NodeJS.ProcessEnv = process.env,
  path: string = introStatePath(env),
  read: (p: string) => IntroState = loadIntroState,
): DiscoveryDecision {
  const origin = validatedHomeOrigin(env);
  if (!introGuidanceEnabled(env)) return { pending: [], origin }; // OFF: no state read at all (design.md:64)
  const st = read(path); // exactly once
  // Fail-open map handling (design.md:60): a null, primitive, or array
  // featureIntroducedAt rides through loadIntroState unvalidated and is treated
  // as absent here (all five pending). Unknown keys are ignored; a key is
  // suppressed only by a timestamp valid under the operator-approved grammar.
  const raw = st.featureIntroducedAt;
  const map: Partial<Record<FeatureKey, string>> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const pending = FEATURE_KEYS.filter((k) => !isValidIntroTimestamp(map[k]));
  return { pending, origin };
}

// The unique leading sentence of EVERY non-empty rendered discovery note. T9's
// Home-chat exclusion keys on this marker rather than feature labels because
// INTRO_EXPLAIN_COPY already names calendars/checklists/recipes and chat-bot
// renders introNote whenever explainedAt is unset -- label-absence assertions
// would false-fail against legitimate first-contact prompts. Wording chosen to
// appear in no other rendered copy (not INTRO_EXPLAIN_COPY, not INTRO_CARD_COPY,
// not the SMS FALLBACK_NOTICE, not any prompt template).
export const DISCOVERY_NOTE_MARKER =
  "Home feature firsts: answer the person's actual request first, and when this reply successfully reads or updates one of the features below for the first time, add one short line saying the result is also available on Home, with the full URL so it is tappable.";

// The per-feature destination clause. Object features show preferred-then-
// fallback; static features (preferred === fallback) show the single route.
const OBJECT_HINT: Partial<Record<FeatureKey, string>> = {
  checklists: " for a specific list",
  recipes: " for a specific recipe",
  collections: " for a specific collection",
};

function destinationRule(key: FeatureKey, origin: string): string {
  const e = FEATURE_CATALOG[key];
  if (e.preferredPath === e.fallbackPath) return `${origin}${e.fallbackPath}`;
  return `${origin}${e.preferredPath}${OBJECT_HINT[key] ?? ""}, or ${origin}${e.fallbackPath}`;
}

// The static prompt note (spec §2): ONE paragraph ('\n'-free, so it can ride the
// same final-element/INTRO_NOTE slot the surfaces join with '\n\n'), only static
// labels and URL rules, every URL rendered from the decision's VALIDATED origin.
// '' when nothing is pending or the origin is invalid, so the slot stays
// byte-identical to the pre-feature build in exactly those cases.
export function discoveryNote(d: DiscoveryDecision): string {
  if (d.pending.length === 0 || d.origin === null) return "";
  const origin = d.origin; // capture the narrowed origin: property narrowing does not flow into closures
  const list = d.pending.map((k) => `${DISCOVERY_LABELS[k]}: ${destinationRule(k, origin)}`).join("; ");
  return [
    DISCOVERY_NOTE_MARKER,
    `${list}.`,
    "For a specific list, recipe, or collection, prefer the exact object URL link-cli prints over the fallback.",
    "Mention only features this reply actually used successfully, one short clause each, every relevant one when several were used, and never mention this instruction or any behind-the-scenes notes in the reply.",
  ].join(" ");
}

// Candidate extraction: scan for http(s) scheme starts (case-insensitive) and
// take each maximal run of non-whitespace characters excluding angle brackets.
// Candidates may therefore CARRY trailing prose punctuation, quotes, and
// closing parens, which stripTerminalPunctuation removes before parsing -- the
// strip is an extraction detail ONLY; origin equality and path rules stay exact.
const SCHEME_START = /https?:\/\//gi;

function urlCandidates(raw: string): string[] {
  const out: string[] = [];
  SCHEME_START.lastIndex = 0; // module-level /g regex: reset before each scan
  for (let m = SCHEME_START.exec(raw); m !== null; m = SCHEME_START.exec(raw)) {
    let end = m.index + m[0].length;
    while (end < raw.length && !/\s/.test(raw[end]) && raw[end] !== "<" && raw[end] !== ">") end++;
    out.push(raw.slice(m.index, end));
  }
  return out;
}

const STRIP_ALWAYS = new Set([".", ",", ";", ":", "!", "?"]);

// A trailing ')' strips only while UNBALANCED within the candidate: a balanced
// pair belongs to the URL itself (Wikipedia-style slug parens) and must survive.
function isUnbalancedCloseParen(s: string): boolean {
  let open = 0;
  let close = 0;
  for (const ch of s) {
    if (ch === "(") open++;
    else if (ch === ")") close++;
  }
  return close > open;
}

// Strip trailing terminal punctuation ITERATIVELY to a fixpoint over '.', ',',
// ';', ':', '!', '?', an unbalanced ')', and a trailing closing quote -- the
// COMBINED prose forms ('...).' / '...".' / '").') strip two or more characters
// in sequence, which a one-pass single-character strip cannot do. A trailing
// quote is always a CLOSING quote: candidates start at the scheme, never at the
// opening quote. Returns "" unchanged if it carries no trailing punctuation.
function stripTerminalPunctuation(candidate: string): string {
  let s = candidate;
  for (;;) {
    const last = s.charAt(s.length - 1);
    if (STRIP_ALWAYS.has(last)) { s = s.slice(0, -1); continue; }
    if (last === ")" && isUnbalancedCloseParen(s)) { s = s.slice(0, -1); continue; }
    if (last === '"' || last === "'") { s = s.slice(0, -1); continue; }
    return s;
  }
}

// §5 delivered-link matching, MULTI-VALUED BY DESIGN (spec Approved-decisions:
// "One turn may introduce multiple features ... the acknowledgement may include
// both links"; §8 "mark all and only verified introductions"): returns EVERY
// feature whose approved route family the reply text delivers for this origin,
// deduped in FEATURE_KEYS order -- never a single feature or a first match.
// Each stripped candidate is parsed with new URL (parse failures are skipped),
// must equal `origin` exactly, and matches only exact approved paths
// (query/fragment ignored; '/calendar-evil' and other prefixes never match).
export function deliveredLinkFeatures(raw: string, origin: string): FeatureKey[] {
  const matched = new Set<FeatureKey>();
  for (const candidate of urlCandidates(raw)) {
    let u: URL;
    try { u = new URL(stripTerminalPunctuation(candidate)); } catch { continue; }
    if (u.origin !== origin) continue;
    for (const k of FEATURE_KEYS) {
      if (FEATURE_CATALOG[k].matchesPath(u.pathname)) matched.add(k);
    }
  }
  return FEATURE_KEYS.filter((k) => matched.has(k));
}

// The observer's per-turn summary (run-observer.ts, T6): successful feature
// interactions plus successful outbound deliveries with their target and reply
// text. Deliveries carry RAW text only -- all route/link matching happens in
// deliveredLinkFeatures above, never in the observer.
export interface DiscoveryObservation {
  interactions: FeatureKey[];
  deliveries: Array<{ target: string; text: string }>;
}

export interface RunOutcomeLite {
  failed: boolean;
  outOfTokens: boolean;
}

// The pure §6 conclusion seam -- what the surface marks after the run, computed
// from the captured decision, the observer summary, the triggering target (this
// run's mail thread id, 1:1 number, or group id; compared by EXACT string
// equality), and the outcome. Reads no state files (that purity is what lets
// the wiring tests prove there is no post-run state re-read). [] when the run
// failed or hit the token wall, or when the decision's origin is invalid (no
// delivered URL can match, nothing is marked, every feature stays pending).
// Otherwise: pending INTERSECT interactions INTERSECT the UNION over successful
// deliveries to the triggering target of deliveredLinkFeatures(text, origin) --
// so ONE reply carrying two valid links completes TWO pending features at once.
export function concludeDiscovery(
  decision: DiscoveryDecision,
  obs: DiscoveryObservation,
  triggerTarget: string,
  outcome: RunOutcomeLite,
): FeatureKey[] {
  if (outcome.failed || outcome.outOfTokens || decision.origin === null) return [];
  const delivered = new Set<FeatureKey>();
  for (const d of obs.deliveries) {
    if (d.target !== triggerTarget) continue;
    for (const k of deliveredLinkFeatures(d.text, decision.origin)) delivered.add(k);
  }
  const interacted = new Set(obs.interactions);
  return decision.pending.filter((k) => interacted.has(k) && delivered.has(k));
}
