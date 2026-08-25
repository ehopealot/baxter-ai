// Per-conversation SMS transcript store: one JSONL file per normalized phone
// number under SMS_TRANSCRIPT_DIR. Sendblue has no queryable scrollback, so
// this file *is* the agent's memory of an SMS conversation. Appends are
// cross-process locked (proper-lockfile, same params as checklist-store.ts /
// send-state.ts) because sms-bot (inbound) and sms-cli (outbound) are
// separate processes that can append to the same conversation concurrently.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { SMS_TRANSCRIPT_DIR } from "./paths.ts";
import { normalizePhone } from "./normalize-phone.ts";

// `from` records the SPEAKER on a group inbound (so the prompt can attribute "who said
// what"); it's absent on a 1:1, where the conversation key already is the speaker.
// Group metadata (spec 2026-08-18-scheduled-sms-group-delivery): every successfully
// applied inbound GROUP message appends the webhook's available group fields to its
// own entry. `group_id` is the EXACT raw provider id (never sanitized), `group_name` /
// `participants` are untrusted display metadata -- persisted as JSON values, never
// interpolated into shell commands. One-to-one and outbound entries stay unchanged.
export type TranscriptEntry = { direction: "in" | "out"; at: string; content: string; media_url?: string; from?: string; group_id?: string; group_name?: string; participants?: string[] };

// The ONE strict provider-group-ID predicate (spec §Group ID boundary), shared by every
// outbound and discovery boundary that requires an exact group identity: transcript
// enumeration, command arguments, schedule records, prompt commands, and Sendblue
// requests. Same shape sms-bot.ts already enforced before interpolating group.id into
// the live reply command. A strict ID keeps the exact, untransformed g-<id>.jsonl
// transcript filename; anything else is quarantined under gx-<sha256>.jsonl.
export const STRICT_GROUP_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export function isStrictGroupId(id: string): boolean {
  return STRICT_GROUP_ID_RE.test(id);
}

// The quarantine path key for a group ID that fails strict validation: lowercase hex
// SHA-256 over the UTF-8 bytes of JSON.stringify(rawGroupId). Hashing the
// JSON.stringify form is what distinguishes JavaScript string values that plain UTF-8
// encoding cannot: JSON.stringify escapes lone surrogate code units as lowercase
// \ud800-\udfff sequences BEFORE encoding, so a raw ID with a lone surrogate and one
// with U+FFFD hash to distinct keys instead of collapsing to the same bytes. The
// digest is always exactly 64 hex chars, so the filename component is bounded however
// long the malformed ID is. This is a collision-resistant path KEY, not a reversible
// encoding: the exact raw ID is preserved as `group_id` on every entry, and gx-*
// reads filter by exact `group_id` equality (entriesForRawGroupId), so even a
// theoretical digest collision cannot mix the logical histories. gx-* transcripts are
// never discoverable, schedulable, or outbound-authorizing.
export function quarantineKey(rawGroupId: string): string {
  return createHash("sha256").update(Buffer.from(JSON.stringify(rawGroupId), "utf8")).digest("hex");
}

// The pure per-raw-ID read filter for gx-* quarantine histories (spec §Group ID
// boundary): a physical gx-<sha256>.jsonl file is shared by every raw ID whose
// JSON.stringify digest collides, so reads of a quarantined conversation are DEFINED
// as "only the entries whose group_id exactly equals the requested raw ID". Exported
// so the interleaved-collision isolation is testable against the production filter.
export function entriesForRawGroupId(entries: TranscriptEntry[], rawGroupId: string): TranscriptEntry[] {
  return entries.filter((e) => e.group_id === rawGroupId);
}

function baseDir(): string {
  return process.env.SMS_TRANSCRIPT_DIR_OVERRIDE || SMS_TRANSCRIPT_DIR;
}

// A conversation key is either an E.164 phone (1:1) or `group:<id>` (a group thread). A
// group id is NOT a phone -- normalizePhone would strip it to a digit soup that collides
// or empties -- so group keys get their own filename namespace. A STRICT id (validated by
// isStrictGroupId, shared with every outbound boundary) keeps the exact, untransformed
// `g-<id>.jsonl` path -- discovery and outbound authorization consult only these. An id
// that FAILS strict validation (post-2026-08-18 inbound) is filed under the fixed
// quarantine path `gx-<sha256>.jsonl` (quarantineKey) in the same directory: history is
// preserved but never discoverable or authorizing, and the exact raw id survives on
// every entry. The two namespaces cannot overlap: a strict `g-<id>` filename has `-` as
// its second character, every `gx-` one has `x`.
function fileFor(convKey: string): string {
  if (convKey.startsWith("group:")) {
    const raw = convKey.slice(6);
    return isStrictGroupId(raw) ? join(baseDir(), `g-${raw}.jsonl`) : join(baseDir(), `gx-${quarantineKey(raw)}.jsonl`);
  }
  const norm = normalizePhone(convKey) ?? convKey;
  const safe = norm.replace(/[^0-9]/g, "") || "unknown"; // E.164 digits, no '+'
  return join(baseDir(), `${safe}.jsonl`);
}

// Create the transcript file (dir + empty file) if missing, so proper-lockfile
// has an existing target to attach its `.lock` to. Atomic "wx" (fail-if-exists)
// with EEXIST swallowed -- NOT a readFileSync probe-then-create -- because
// sms-bot (inbound append) and sms-cli (outbound append) are separate
// processes that can race the first-ever file create for a new phone number;
// the loser of a read-then-create probe would throw. Mirrors send-state.ts's
// ensureFile.
function ensure(p: string): void {
  mkdirSync(baseDir(), { recursive: true });
  try {
    writeFileSync(p, "", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
  }
}

// Strictly transcript-file existence: true iff this conversation's JSONL file is on
// disk. The file may now be created either by an inbound append (sms-bot) or by a
// successful first outbound through gatedSend (which owns the outbound transcript
// append) -- so existence does NOT imply the number ever texted in. Its remaining
// callers are transcript-admitted paths: sms-cli's sendGroupSms (a group reply requires
// the group's received transcript) and sendPresence (read receipts + typing indicators
// require a 1:1 transcript, always true for the inbound sender that triggers them) -- a
// direct 1:1 sendSms/sendContactCard is admitted by the household roster instead (see
// sms-cli.ts's admittedRecipient) and does NOT consult this. For a group key whose id
// fails strict validation this is deliberately FALSE even when a gx-* quarantine file
// exists: strict validation always precedes the authorization lookup at every caller,
// so hasTranscript("group:<id>") always resolves the exact strict g-<id>.jsonl file and
// a quarantined history can never authorize or satisfy anything.
export function hasTranscript(phone: string): boolean {
  if (phone.startsWith("group:") && !isStrictGroupId(phone.slice(6))) return false;
  return existsSync(fileFor(phone));
}

export async function appendTranscript(phone: string, entry: TranscriptEntry, signal?: AbortSignal): Promise<void> {
  const p = fileFor(phone);
  ensure(p);
  if (signal?.aborted) throw signal.reason ?? new Error("sms transcript append aborted");
  let release!: () => Promise<void>;
  if (!signal) {
    release = await lockfile.lock(p, {
      realpath: false, stale: 10000,
      retries: { retries: 30, minTimeout: 30, maxTimeout: 300 },
    });
  } else {
    let delay = 30;
    for (let attempt = 0;; attempt++) {
      if (signal.aborted) throw signal.reason ?? new Error("sms transcript append aborted");
      try { release = await lockfile.lock(p, { realpath: false, stale: 10000, retries: { retries: 0 } }); break; }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ELOCKED" || attempt >= 30) throw err;
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("sms transcript append aborted")); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, delay);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        delay = Math.min(delay * 2, 300);
      }
    }
  }
  try {
    if (signal?.aborted) throw signal.reason ?? new Error("sms transcript append aborted");
    appendFileSync(p, JSON.stringify(entry) + "\n");
  } finally {
    await release();
  }
}

// Shared JSONL parse (corrupt lines ignored) for every transcript read, so the
// summary scan and per-conversation reads can't drift on corruption handling.
function parseEntries(raw: string): TranscriptEntry[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as TranscriptEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is TranscriptEntry => e !== null);
}

export function readTranscript(phone: string, limit?: number): TranscriptEntry[] {
  const p = fileFor(phone);
  let raw = "";
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  // A gx-* quarantine file is a shared physical log keyed by digest, so its logical
  // history is defined by exact `group_id` equality (entriesForRawGroupId) -- even a
  // digest collision can never mix two raw IDs' entries. Strict g-<id> transcripts are
  // exact-by-construction and skip the filter.
  let entries = parseEntries(raw);
  if (phone.startsWith("group:") && !isStrictGroupId(phone.slice(6))) {
    entries = entriesForRawGroupId(entries, phone.slice(6));
  }
  return limit ? entries.slice(-limit) : entries;
}

// --- Group discovery (spec 2026-08-18-scheduled-sms-group-delivery §Transcript
// metadata and discovery) ----------------------------------------------------------
// Transcripts are BOTH the discovery source and the authorization source (no separate
// registry). A summary carries only identity + display metadata -- never message
// bodies or media URLs. Legacy (pre-metadata) transcripts stay eligible: they expose
// just id, known speakers, and last activity until their next inbound enriches them.

export interface SmsGroupSummary {
  id: string;
  name: string | null;
  participants: string[];
  speakers: string[];
  lastActivity: string | null;
}

// An entry's metadata is identity-consistent with a strict transcript file when its
// group_id is absent (legacy / outbound entries) or exactly matches the filename ID --
// a mismatched value is ignored and can never retarget the file.
function identityConsistent(e: TranscriptEntry, id: string): boolean {
  return e.group_id === undefined || e.group_id === id;
}

// Scan ONLY strict g-<id>.jsonl transcripts (never gx-*.jsonl, whose stem starts
// "gx-"), skipping any g-*.jsonl whose suffix is not a strict group ID. Phone files
// (bare digits) don't start with "g-" and are skipped by the same prefix test.
export function smsGroupSummaries(): SmsGroupSummary[] {
  let names: string[];
  try {
    names = readdirSync(baseDir());
  } catch {
    return []; // no transcript dir yet -> no groups
  }
  const out: SmsGroupSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const stem = name.slice(0, -".jsonl".length);
    if (!stem.startsWith("g-") || stem.startsWith("gx-")) continue; // gx-* quarantine is never scanned
    const id = stem.slice(2);
    if (!isStrictGroupId(id)) continue; // invalid group transcript filenames are skipped
    let raw = "";
    try {
      raw = readFileSync(join(baseDir(), name), "utf8");
    } catch {
      continue;
    }
    const entries = parseEntries(raw);
    let groupName: string | null = null;
    let participants: string[] = [];
    const speakers: string[] = [];
    for (const e of entries) { // forward scan, last consistent value wins (most recent)
      if (identityConsistent(e, id)) {
        if (typeof e.group_name === "string" && e.group_name !== "") groupName = e.group_name;
        if (Array.isArray(e.participants)) participants = e.participants;
      }
      if (e.direction === "in" && typeof e.from === "string" && e.from !== "" && !speakers.includes(e.from)) speakers.push(e.from);
    }
    // The NEWEST entry's timestamp only (transcripts append chronologically), or null
    // for an empty legacy file or an undated newest entry. No backward walk: reporting
    // an older dated entry's timestamp when the newest entry is undated would present
    // stale activity as current (spec 2026-08-18-scheduled-sms-group-delivery
    // §Group summaries -- "the newest transcript entry's timestamp, or null").
    const newest = entries[entries.length - 1];
    const lastActivity = newest !== undefined && typeof newest.at === "string" ? newest.at : null;
    out.push({ id, name: groupName, participants, speakers, lastActivity });
  }
  // Valid lastActivity descending; undated groups after dated ones; deterministic ID
  // tie-breaker.
  const ts = (s: SmsGroupSummary): number => {
    if (!s.lastActivity) return -Infinity;
    const t = Date.parse(s.lastActivity);
    return Number.isNaN(t) ? -Infinity : t;
  };
  out.sort((a, b) => ts(b) - ts(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
