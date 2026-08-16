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
}

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
export const INTRO_EXPLAIN_COPY = "This is your first exchange with this household. Answer their actual message first, then in a line or two, warmly say what you can help with: email, texting, family chat, shared calendars, checklists, recipes and meal planning, web lookups, and reminders. If they set up the household, you can also mention they can add the rest of the family from the settings page (home.bax.bot/settings). Keep it short and skip anything that doesn't fit.";
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
