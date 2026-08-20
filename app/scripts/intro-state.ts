// The first-contact INTRO latch (spec: docs/superpowers/specs/2026-08-15-first-contact-
// intro-design.md): two independent once-per-household flags in one small JSON file --
//
//  - explainedAt      set once, by whichever surface (sms/mail/chat) produces the
//                     household's FIRST reply; while unset, every one of the three
//                     buildPrompts appends the "tell them what you can help with" block.
//  - smsCardSentAt    set once, by the SMS surface's first 1:1 run that rendered the
//                     contact-card block (regardless of whether the run actually called
//                     `sms-cli send-contact` -- the once-only contract is about the OFFER;
//                     a model that skipped the call must not re-trigger it forever). Set
//                     independent of explainedAt, so an email-first household that already
//                     got the explanation still gets ONLY the card line on its first SMS.
//  - featureIntroducedAt  a PARTIAL per-Home-feature map (FEATURE_KEYS below is the key
//                     union's single source of truth): when each feature's Home link was
//                     first successfully delivered in a reply. A missing or invalid (per
//                     isValidIntroTimestamp) value means "still pending". Judged and
//                     merged ONLY by markFeaturesIntroduced here; read by
//                     feature-discovery.ts's decision (spec 2026-08-19-cross-surface-
//                     home-link-discovery-design.md §1).
//
// Gated fleet-wide by BAXTER_INTRO_GUIDANCE (introGuidanceEnabled): unset/empty/0/false
// = OFF -- no latch READS or WRITES anywhere, prompts byte-identical to the no-intro
// build; a latch left over from an earlier ON period is simply ignored.
//
// Concurrency posture: unlike home-state.ts's single writer, ANY of the three surfaces'
// dispatch paths may write -- but each write is a fully SYNCHRONOUS read-modify-write
// (loadIntroState -> saveIntroState, no await between), so the surfaces sharing the
// light container's one event loop can never interleave. The only residual race is two
// separate PROCESSES (a dev box running per-surface containers) completing first runs
// within the microsecond write window; last-writer-wins could drop one flag, whose
// consequence is exactly the fail-open case below -- the dropped block re-renders once
// and re-marks. Harmless by design; not worth a cross-process lock.
//
// Fail-open is TOTAL and deliberate (stricter than home-state.ts, which rethrows
// non-ENOENT read errors): a missing, corrupt, or unreadable latch reads as "nothing
// set yet", so the worst case is re-explaining once -- it can never BLOCK a reply,
// which a throw out of buildPrompt would.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { INTRO_STATE_PATH } from "./paths.ts";

export interface IntroState {
  explainedAt?: string;   // ISO timestamp of the household's first explained reply
  smsCardSentAt?: string; // ISO timestamp of the first 1:1 SMS run that offered the card
  // No validation happens on load (fail-open, design.md:60): a null, primitive, or
  // array map rides through inside a valid top-level object and is treated as an
  // absent map downstream -- by markFeaturesIntroduced's merge and feature-discovery's
  // pending computation. Values are judged only via isValidIntroTimestamp.
  featureIntroducedAt?: Partial<Record<FeatureKey, string>>;
}

// The five Home features tracked per household in featureIntroducedAt. SINGLE
// SOURCE OF TRUTH for the feature-key union: feature-discovery.ts imports these;
// no other module may redefine the list (exactly one 'as const' feature-key list
// repo-wide).
export const FEATURE_KEYS = ["calendar", "checklists", "recipes", "collections", "scheduled"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export function freshIntroState(): IntroState {
  return {};
}

// The latch file's location. INTRO_STATE_PATH_OVERRIDE (read at CALL time, mirroring
// SMS_TRANSCRIPT_DIR_OVERRIDE / USAGE_DIR_OVERRIDE) exists purely so tests can point
// the latch at a tmpdir without touching a real tenant's state dir.
export function introStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.INTRO_STATE_PATH_OVERRIDE || INTRO_STATE_PATH;
}

// Read the latch, tolerating ANY failure (missing, corrupt, unreadable) by falling
// back to fresh -- see the header's fail-open contract. A non-object parse (e.g. "3")
// is also fresh; unknown extra keys ride along (spread below) so a future field
// upgrades in place like home-state's backfill behavior.
export function loadIntroState(path: string = introStatePath()): IntroState {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch { return freshIntroState(); }
  try {
    const parsed = JSON.parse(raw) as Partial<IntroState> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return freshIntroState();
    return { ...freshIntroState(), ...parsed };
  } catch {
    return freshIntroState();
  }
}

export function saveIntroState(state: IntroState, path: string = introStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

// Set explainedAt (idempotent: an already-set flag keeps its FIRST timestamp -- no
// rewrite, so the mark is also monotonic under redelivery/retry). Throws only on an
// fs write failure; callers keep the write best-effort (log, never fail the reply).
export function markExplained(at: string = new Date().toISOString(), path: string = introStatePath()): void {
  const st = loadIntroState(path);
  if (st.explainedAt) return;
  saveIntroState({ ...st, explainedAt: at }, path);
}

// Set smsCardSentAt, preserving explainedAt (and vice versa above) -- one file, two
// independent flags, merged on every write.
export function markCardSent(at: string = new Date().toISOString(), path: string = introStatePath()): void {
  const st = loadIntroState(path);
  if (st.smsCardSentAt) return;
  saveIntroState({ ...st, smsCardSentAt: at }, path);
}

// Spec §1 timestamp validity under the operator-approved boundary (2026-08-20): a
// value counts as "introduced" only when it is a non-empty string that (a) is
// LEXICALLY one of -- a date-time YYYY-MM-DDTHH:MM with optional :SS and 0-3
// fractional digits, terminated by 'Z', '+HH:MM'/'-HH:MM', or the colon-less
// '+HHMM'/'-HHMM' (every date-time form REQUIRES a timezone); the date-only
// YYYY-MM-DD (the sole timezone-exempt form); or the exact end-of-day variant
// T24:00 (zero minute, second, and fraction only: 'T24:00', 'T24:00:00',
// 'T24:00:00.000' with any accepted terminator); (b) yields a FINITE Date.parse;
// and (c) is CALENDAR-VALID by component check (month 1-12, day within the month
// -- leap-year aware -- minute/second <= 59, hour <= 23 except the exact 24:00,
// offset hour <= 23 / offset minute <= 59). All three legs are required: on
// Node v24 '2026-02-31T00:00:00Z' parses FINITE but rolls to 2026-03-03, and
// 'March 1, 2026' parses finite but is not ISO. Deliberately NO round-trip
// equality against toISOString() -- it re-renders Z and would reject the valid
// date-only and numeric-offset originals this must preserve verbatim. Anything
// unrecognized leaves the feature pending (fail-open; never blocks a reply).
const ISO_TIMESTAMP =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})(?:T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?<frac>\.\d{1,3})?)?(?<zone>Z|[+-]\d{2}:?\d{2}))?$/;

export function isValidIntroTimestamp(v: unknown): boolean {
  if (typeof v !== "string" || v === "") return false;
  const m = ISO_TIMESTAMP.exec(v);
  if (!m?.groups) return false;
  const { month, day, hour, minute, second, frac, zone } = m.groups;
  const year = Number(m.groups.year);
  const mo = Number(month);
  if (mo < 1 || mo > 12) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  if (Number(day) < 1 || Number(day) > daysInMonth) return false;
  if (hour !== undefined) {
    const h = Number(hour);
    const mi = Number(minute);
    const s = second === undefined ? 0 : Number(second);
    if (mi > 59 || s > 59) return false;
    // The exact end-of-day variant: hour 24 with zero minute, second, and fraction.
    const exact2400 = h === 24 && mi === 0 && s === 0 && (!frac || /^\.0{1,3}$/.test(frac));
    if (h > 23 && !exact2400) return false;
    if (zone && zone !== "Z") {
      if (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(-2)) > 59) return false;
    }
  }
  return Number.isFinite(Date.parse(v));
}

// Set featureIntroducedAt for the given features (idempotent per feature: a key
// already holding a VALID timestamp keeps its FIRST value -- an offset-form
// original is never rewritten to Z; spec §1 "existing timestamps win"). ENV-
// CONSISTENT with introDecision: the default path resolves from the EXPLICIT env
// parameter via introStatePath(env), NOT from bare introStatePath()/process.env
// (the pre-existing markExplained/markCardSent default bare -- out of scope to
// change -- so a caller whose discovery read used a non-global env object gets
// the SAME latch file here; env sits before `at` so callers pass just
// (features, env) with no placeholder undefineds). One synchronous read ->
// merge -> at most ONE atomic write for the whole set; write EXACTLY ONCE when
// any requested feature is absent or invalid, ZERO times when all are already
// valid. The io seam (read/write, per-field defaulting to the real functions)
// exists so tests can count saves at the resolved path. Throws only on an fs
// write failure; callers keep the write best-effort (log, never fail the reply).
export function markFeaturesIntroduced(
  features: FeatureKey[],
  env: NodeJS.ProcessEnv = process.env,
  at: string = new Date().toISOString(),
  path: string = introStatePath(env),
  io: { read?: (p: string) => IntroState; write?: (s: IntroState, p: string) => void } = { read: loadIntroState, write: saveIntroState },
): void {
  const read = io.read ?? loadIntroState;
  const write = io.write ?? saveIntroState;
  const st = read(path);
  // Fail-open merge: a non-plain-object map (null, primitive, array) is treated
  // as absent (design.md:60) -- never a throw; unknown keys ride along below.
  const raw = st.featureIntroducedAt;
  const existing: Partial<Record<FeatureKey, string>> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const merged: Partial<Record<FeatureKey, string>> = { ...existing };
  let dirty = false;
  for (const f of features) {
    if (!isValidIntroTimestamp(existing[f])) {
      merged[f] = at;
      dirty = true;
    }
  }
  if (!dirty) return;
  write({ ...st, featureIntroducedAt: merged }, path);
}

// The fleet flag: ON for anything except unset/empty/0/false (case-insensitive,
// whitespace-tolerant). Default OFF in code; the SHIPPED default comes from the
// templates (app/.env.example and base.env render BAXTER_INTRO_GUIDANCE=1), so an
// unconfigured box changes nothing until the template layer says so.
export function introGuidanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.BAXTER_INTRO_GUIDANCE ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

// The per-run rendering/marking decision. `explain` = the shared "first exchange"
// block renders (flag ON + explainedAt unset). `card` = the SMS-ONLY contact-card
// line renders -- and is only ever true when `isSms1to1` is true (an SMS surface run
// that is NOT a group); mail/chat pass nothing (default false) and can never see it.
// The card is INDEPENDENT of `explain` (an email-first household that already got the
// explanation still gets only the card line on its first SMS). Computed from the SAME
// inputs by buildPrompt (rendering) and each surface's dispatch path (marking after
// the run) -- a cheap synchronous read, and re-deriving it after the run is safe: a
// flag can only go unset->set, so a mark the render already justified is either still
// due or already done by a concurrent run (markExplained/markCardSent no-op).
export interface IntroDecision { explain: boolean; card: boolean }
export function introDecision(env: NodeJS.ProcessEnv = process.env, isSms1to1 = false, path: string = introStatePath(env)): IntroDecision {
  if (!introGuidanceEnabled(env)) return { explain: false, card: false }; // OFF: no latch read at all
  const st = loadIntroState(path);
  return { explain: !st.explainedAt, card: isSms1to1 && !st.smsCardSentAt };
}

// The prompt copy, verbatim from spec §3. One source shared by all three surfaces so
// the wording can't drift between them; each surface adapts only the LINE BREAKS to
// its prompt's format (template slot vs joined array element).
export const INTRO_EXPLAIN_COPY = "This is your first exchange with this household. Answer their actual message first, then in a line or two, warmly say what you can help with: email, texting, family chat, shared calendars, checklists, recipes and meal planning, web lookups, and reminders. If they set up the household, you can also mention they can add the rest of the family from the settings page at https://home.bax.bot/settings (include the full URL so it's tappable). Keep it short and skip anything that doesn't fit.";
export const INTRO_CARD_COPY = "After your reply text, call the `send-contact` CLI for this number to send your contact card, so they can save you.";

// The rendered note for a decision: the explain paragraph, then (SMS 1:1, card due)
// the card sentence as its own paragraph; "" when nothing renders, so a surface can
// pass it straight through an empty-when-off slot and stay byte-identical when off.
export function introNote(d: IntroDecision): string {
  const parts: string[] = [];
  if (d.explain) parts.push(INTRO_EXPLAIN_COPY);
  if (d.card) parts.push(INTRO_CARD_COPY);
  return parts.join("\n\n");
}
