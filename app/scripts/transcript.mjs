// Provider-neutral transcript sanitization -- the transcript-forgery defenses
// extracted out of gmail.mjs so the email adapter (mail.mjs), the Discord surface
// (discord-bot.mjs), and runtime.mjs all share one copy. This is the most-reviewed
// code in the repo; the logic here is UNCHANGED from gmail.mjs's original, with one
// deliberate difference called out below at formatThreadMessage (it now takes a
// PROVIDER-NEUTRAL normalized message and normalizes `text` itself). See
// docs/superpowers/specs/2026-07-22-agentmail-migration-design.md and, for the full
// reasoning behind each piece, app/CLAUDE.md's "transcript-forgery sanitization
// pipeline" section.
import { randomUUID } from "node:crypto";

// Codepoints, not literal characters or \u escape sequences, in source: the two
// Unicode separator characters here are themselves LineTerminator characters at the
// JS lexical level, so embedding either literally inside a regex literal (even via a
// \u escape -- some text pipeline between typing this and the file landing on disk
// silently expanded it to the raw character, confirmed the hard way) breaks the
// parser. String.fromCodePoint sidesteps that entirely: everything typed here is
// plain ASCII digits.
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const NEXT_LINE = String.fromCodePoint(0x0085);

// Every sanitizer here (neutralizeStructuralMarkers, neutralizeDanglingSeparatorTail)
// matches literal "\n" only, but a claude -p run reading the transcript isn't a
// byte-exact string splitter -- any character that renders or is interpreted as a
// line break reads as a real boundary to it regardless of the exact bytes underneath.
// Beyond "\r\n"/bare "\r" (RFC 5322's conventional line ending), this also covers
// LINE_SEPARATOR/PARAGRAPH_SEPARATOR/NEXT_LINE and \v/\f (vertical tab/form feed).
//
// Invisible Unicode format characters (\p{Cf}: zero-width space/joiners, LRM/RLM and
// bidi controls, soft hyphen, etc.) are stripped FIRST, before any byte-exact matcher
// downstream runs -- a model reading the transcript isn't a byte-exact splitter, so a
// name/body could otherwise hide an invisible inside a structural token to evade
// neutralization, or (if stripped only afterward) reconstruct the exact bytes the
// neutralizer was supposed to break. Both transcript surfaces (email formatThreadMessage
// + mail.mjs/poll.mjs From/Subject; Discord clean()) reach this via
// normalizeTranscriptText, so this one placement covers both. ASCII regex source -- no
// exotic codepoint typed (see the Unicode sharp-edge note).
const STRIP_INVISIBLE = /\p{Cf}/gu;
export function normalizeTranscriptText(text) {
  return text
    .replace(STRIP_INVISIBLE, "")
    .replace(/\r\n|\r/g, "\n")
    .split(LINE_SEPARATOR)
    .join("\n")
    .split(PARAGRAPH_SEPARATOR)
    .join("\n")
    .split(NEXT_LINE)
    .join("\n")
    .replace(/[\v\f]/g, "\n");
}

// Gmail's `from:` search operator (and any header-derived address) matches the whole
// From header, display name included -- `From: "erikjhope@gmail.com" <attacker@evil.com>`
// satisfies a naive `from:erikjhope@gmail.com`. This parses out just the actual
// address for a real check.
export function extractEmailAddress(fromHeader) {
  // Greedy .* forces the match to the LAST <...> group, not the first: a display name
  // can itself contain an angle-bracketed address (e.g. `"erik <allowed@x.com>"
  // <attacker@evil.com>`), and per RFC 5322 mailbox syntax the real deliverable
  // addr-spec is always the trailing one, whichever position an attacker crafts the
  // header to make a naive first-match land on.
  const angleBracketMatch = fromHeader.match(/.*<([^>]+)>/);
  return (angleBracketMatch ? angleBracketMatch[1] : fromHeader).trim().toLowerCase();
}

export const TRIGGER_MARKER = "[^ RESPOND TO THIS MESSAGE]";
export const MESSAGE_SEPARATOR = "\n\n---\n\n";

// A random, unpredictable placeholder generated fresh per call (used in
// formatThreadMessage below), not a fixed constant: a fixed string is trivially
// embeddable by an attacker (or present in forwarded/quoted content within the trigger
// message's own body), and the blind substitution step that promotes it to the real
// marker would then also promote that pre-existing occurrence -- forging a second
// marker mid-body. A UUID contains no "-" runs of 3+ (its hyphens are isolated single
// characters between hex groups) and no "\n", so it can't form or be mistaken for
// either structural string, and being freshly random each call means it can't be
// predicted or pre-planted.
function makePlaceholder() {
  return ` ${randomUUID()} `;
}

// Message content is otherwise interpolated into the transcript verbatim, so a body
// (or subject) that happens to literally contain the marker or separator string --
// forwarded/quoted content, or a deliberate attempt -- would be indistinguishable from
// the real structural marker/boundary. Applied to every message, not just untrusted
// ones, since even an allowed sender could innocently forward/quote these strings.
//
// Must run on the fully-composed per-message block, not on individual fields before
// they're interpolated: a body that merely starts with "---\n\n" (or ends with
// "\n\n---") contains no full separator on its own and would pass field-level
// sanitization untouched, but combined with the template's own literal "\n\n"
// immediately before the body it forms a genuine "\n\n---\n\n" -- an intact,
// indistinguishable forged message boundary. Sanitizing the composed block catches
// that seam.
//
// Looped to a fixed point rather than a single split/join pass: adjacent, overlapping
// occurrences of MESSAGE_SEPARATOR share their middle "\n\n", so a single pass only
// consumes the first one -- the replacement's own trailing "\n\n" then recombines with
// the unconsumed leftover "---\n\n" to reconstruct an intact separator right back into
// the output. Repeating until nothing changes catches every reconstructed instance;
// each pass removes at least one, so this always terminates.
//
// Always targets the real TRIGGER_MARKER text, never a placeholder: this runs on the
// trigger message's own per-call placeholder too (see formatThreadMessage), and it must
// NOT treat that placeholder itself as something to neutralize -- doing so would destroy
// it before it can be substituted for the real marker afterward. The placeholder is
// random and never equal to TRIGGER_MARKER's literal text, so it always survives this
// pass untouched regardless.
export function neutralizeStructuralMarkers(text) {
  let result = text;
  for (;;) {
    const next = result
      .split(TRIGGER_MARKER)
      .join("[marker text neutralized]")
      .split(MESSAGE_SEPARATOR)
      .join("\n\n- - -\n\n");
    if (next === result) return next;
    result = next;
  }
}

// A block that itself ends in "\n\n" followed by a run of hyphens (and optionally a
// single trailing newline -- "\n\n---" and "\n\n---\n" are the only two suffix
// decompositions of MESSAGE_SEPARATOR that can appear at a block's own end and still be
// completed by what follows) doesn't yet contain a complete MESSAGE_SEPARATOR --
// neutralizeStructuralMarkers above leaves it alone -- but whatever gets concatenated
// directly after it (the caller's own MESSAGE_SEPARATOR join, immediately following once
// this returns) supplies exactly the missing "\n\n" (or just the final "\n"), completing
// a spurious extra boundary right at the seam, in addition to the real one the join
// inserts. Only the body is ever attacker-influenced at a block's very end -- every block
// otherwise starts with a fixed "From: " prefix, and the trigger marker (when present) is
// fixed trailing text -- so this only ever needs to inspect the tail.
export function neutralizeDanglingSeparatorTail(text) {
  return text.replace(
    /\n\n(-+)(\n?)$/,
    (_, dashes, trailingNewline) => `\n\n${dashes.split("").join(" ")}${trailingNewline}`,
  );
}

// Formats one message block for the transcript from a PROVIDER-NEUTRAL normalized
// message: { from, date, subject, text, isOwn, isAllowed } (all strings + two booleans).
// The provider adapter (mail.mjs) extracts those fields and computes isOwn (the
// unforgeable own-message label) / isAllowed (the allowlist), keeping this function
// transport-agnostic and directly unit-testable.
//
// isTrigger marks the specific message to respond to explicitly, rather than the model
// having to infer it from transcript position -- position isn't reliable: the trigger is
// chosen from list-new's candidates, not by timestamp over the whole thread, so a message
// chronologically after the trigger (typically the agent's own reply, composed while this
// one was in flight) can legitimately appear later without being what the model acts on.
export function formatThreadMessage(msg, isTrigger) {
  const { from, date, subject, text, isOwn, isAllowed } = msg;
  let block;
  // Redact any participant who is neither an allowlisted sender nor the agent itself.
  // From/Subject/Date are all just as attacker-controlled and unbounded as the body
  // (e.g. a crafted Date header could itself carry an instruction), so redact all of
  // them rather than leaving any open.
  if (!isAllowed && !isOwn) {
    block =
      "From: [redacted -- sender not on the allowlist]\nDate: [redacted]\nSubject: [redacted]\n\n[content omitted -- sender is not on the allowlist]";
  } else {
    // Normalize EVERY field here, `text` included. The header values are normalized for
    // the same "\r\n\r\n---\r\n\r\n"-style bypass the body normalization closes -- a
    // provider can unfold header continuations onto separate lines without guaranteeing
    // bare "\n". `text` is normalized here (not only upstream) so sanitization is
    // self-contained regardless of adapter discipline: neutralizeStructuralMarkers
    // matches literal "\n" only, so an un-normalized CRLF/U+2028 body would otherwise
    // sail past it and forge a boundary (spec Finding 4).
    block = `From: ${normalizeTranscriptText(from)}\nDate: ${normalizeTranscriptText(date)}\nSubject: ${normalizeTranscriptText(subject)}\n\n${normalizeTranscriptText(text)}`;
  }
  let final;
  if (!isTrigger) {
    final = neutralizeStructuralMarkers(block);
  } else {
    // A placeholder stands in for the real marker while sanitizing, rather than
    // appending the real marker afterward: appending after sanitization would introduce
    // a fresh, never-sanitized "\n\n" boundary of its own -- a body ending in "\n\n---"
    // would combine with that boundary to form a genuine separator, invisible to a
    // sanitization pass that already ran before the marker existed. Only substituted back
    // to the real marker after sanitization is fully done, and only for the trigger.
    const placeholder = makePlaceholder();
    const withPlaceholder = `${block}\n\n${placeholder}`;
    final = neutralizeStructuralMarkers(withPlaceholder).split(placeholder).join(TRIGGER_MARKER);
  }
  return neutralizeDanglingSeparatorTail(final);
}
