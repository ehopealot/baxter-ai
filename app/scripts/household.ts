// The household roster: who lives here and how to reach them, rendered fresh into the
// preamble of every mail/SMS/chat/heartbeat/TUI-main prompt (Discord, voice, onboarding,
// and eval surfaces deliberately get NO roster -- a non-member there can never leak one).
// A read-only renderer with injectable I/O paths, same posture as collectionsPreamble/
// skillsPreamble: it renders the section BODY only -- the prompt templates own the header
// (like {{COLLECTIONS_LIST}}) -- and reads the shared runtime allowlist FRESH on each call
// (loadAllowlist), so household-settings changes surface on the next prompt without a
// restart. The body is roster lines + one blank line + a guidance paragraph whose
// settings-page URL is derived from the operator-provisioned home-keys endpoint origin
// (both http and https origins are valid); anything else -- missing/corrupt keys, a
// non-string or unparseable endpoint, a non-http(s) protocol, a "null" origin -- falls
// back to the URL-less "on the settings page" wording, and the read never throws. This
// module NEVER writes (home-bot is the allowlist's sole writer) and does NOT import
// `home-mirror.ts`, keeping the helper independent of `home-mirror.ts`.
import { readFileSync } from "node:fs";
import { loadAllowlist, admitEmail, admitPhone } from "./allowlist.ts";
import { cleanForPromptLine } from "./transcript.ts";
import { ALLOWLIST_PATH, HOME_KEYS_PATH } from "./paths.ts";

// Address admission runs AT RENDER: loadAllowlist only filters entries to strings, and the
// allowlist file is hand-editable (baxctl provisioning, an operator poking the config
// volume), so shape is re-checked here via allowlist.ts's shared admission predicates
// (admitEmail/admitPhone -- the ONE in-core copy of these shapes; the outer repo keeps
// its own members.ts copy, separate repos). The '@'-dispatch picks the branch without
// loosening either shape: EMAIL_RE requires an '@' and the strict E.164 phone shape
// forbids it, so any entry is admissible by at most one predicate. Anything else is
// silently dropped -- per-entry drops are benign (junk never renders into a prompt), and
// loadAllowlist already logs file-level corruption. The validation key (lowercased email /
// phone as-is) is what gets deduped on, looked up in `names`, and rendered -- never the
// raw casing.
function admitAddress(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return admitEmail(trimmed);
  return admitPhone(trimmed);
}

// Rendered-size caps: at most this many roster lines (then one overflow line), so a huge
// or misconfigured household cannot blow up every prompt; and at most this many addresses
// on a single named line (then " …and +N more").
const HOUSEHOLD_MAX = 40;
const LINE_MAX = 6;

// The guidance's settings-page link: the origin of the home-keys endpoint -- the same
// origin home-bot derives for welcome-email buttons. The keys are read DIRECTLY
// (readFileSync + JSON.parse in try/catch) rather than via home-mirror's loadHomeKeys,
// which only truth-checks fields: shape is re-validated here because the file is
// hand-editable. Only an http: or https: origin (BOTH are valid -- an https-only guard
// would break local-http deployments) that is not the string "null" becomes a link;
// everything else yields null (the caller renders the URL-less wording). Never throws.
function settingsOrigin(homeKeysPath: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(homeKeysPath, "utf8"));
  } catch {
    return null; // missing or corrupt file -- URL-less variant
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const endpoint = (parsed as { endpoint?: unknown }).endpoint;
  if (typeof endpoint !== "string") return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.origin === "null") return null; // defense-in-depth after the protocol gate
  return url.origin;
}

// The guidance paragraph, identical on every surface, rendered unconditionally (even
// under "(nobody yet)"): what the roster enables, how to reach someone new, and the
// enforceable SMS destination rule (a household-listed phone number may be texted;
// an unlisted number may not -- local transcript history is never a factor).
const GUIDANCE_TAIL =
  "For texting, you can text any phone number listed for the household above; a number that isn't listed can't be texted.";

function guidanceParagraph(homeKeysPath: string): string {
  const origin = settingsOrigin(homeKeysPath);
  const reach = origin === null
    ? "they must first be added to the household on the settings page."
    : `they must first be added to the household at ${origin}/settings.`;
  return `You can email or text the people above. To reach someone new by email, ${reach} ${GUIDANCE_TAIL}`;
}

export function householdPreamble(
  env: NodeJS.ProcessEnv = process.env,
  allowlistPath: string = ALLOWLIST_PATH,
  homeKeysPath: string = HOME_KEYS_PATH,
): string {
  const list = loadAllowlist(env, allowlistPath);

  // senders ∪ recipients ∪ OPERATOR_EMAIL, deduped on the canonical key (insertion order:
  // senders, then recipients, then the operator). The operator union mirrors how
  // mail-cli.ts's allowedRecipients unions OPERATOR_EMAIL into mail reachability, with one
  // deliberate divergence: the roster runs OPERATOR_EMAIL through the same admission rules
  // as file entries and silently drops a malformed value, so junk never renders. Stale
  // `names` keys are ignored naturally -- only admitted keys are ever looked up.
  const admitted = new Set<string>();
  const add = (raw: string): void => {
    const key = admitAddress(raw);
    if (key !== null) admitted.add(key);
  };
  for (const s of list.senders) add(s);
  for (const r of list.recipients) add(r);
  if (typeof env.OPERATOR_EMAIL === "string") add(env.OPERATOR_EMAIL);

  if (admitted.size === 0) return `(nobody yet)\n\n${guidanceParagraph(homeKeysPath)}`;

  // Names are re-sanitized AT RENDER via cleanForPromptLine: a hand-edited name collapses
  // to a single line (newlines flatten to spaces BEFORE marker-neutralization), so
  // attacker-controlled text can never forge a column-0 prompt line -- the only column-0
  // content here is the sanctioned bullets/overflow lines below. A name that cleans to
  // empty falls back to a bare-address line. Named entries group by EXACT cleaned name
  // (case variants are distinct people, distinct lines); buckets are mutated in place so
  // a huge same-name group costs O(N), not O(N^2) array copies.
  const groups = new Map<string, string[]>(); // cleaned name -> canonical keys
  const unnamed: string[] = [];
  for (const key of admitted) {
    const name = cleanForPromptLine(list.names?.[key] ?? "");
    if (name === "") unnamed.push(key);
    else {
      const bucket = groups.get(name);
      if (bucket === undefined) groups.set(name, [key]);
      else bucket.push(key);
    }
  }

  // One line per distinct name: emails first then phones, each group case-insensitively
  // alphabetical (keys are already-lowercased emails / caseless phones), ", "-joined,
  // capped at LINE_MAX then " …and +N more" (note the literal +, unlike the roster-level
  // overflow). Unnamed entries get one bare-address line each.
  const renderAddresses = (keys: string[]): string => {
    const emails = keys.filter((k) => k.includes("@"));
    const phones = keys.filter((k) => !k.includes("@"));
    const byFolded = (a: string, b: string): number => a.toLowerCase().localeCompare(b.toLowerCase());
    emails.sort(byFolded);
    phones.sort(byFolded);
    const all = [...emails, ...phones];
    if (all.length <= LINE_MAX) return all.join(", ");
    return `${all.slice(0, LINE_MAX).join(", ")} …and +${all.length - LINE_MAX} more`;
  };
  const out: { label: string; text: string }[] = [];
  for (const [name, keys] of groups) out.push({ label: name, text: `- ${name} — ${renderAddresses(keys)}` });
  for (const key of unnamed) out.push({ label: key, text: `- ${key}` });

  // Case-insensitive by leading label (the name for named lines, else the address);
  // equal-folded labels tie-break on the RAW label via localeCompare so the order is
  // deterministic (e.g. "Erik Hope" vs "erik hope" stays two stable lines, lowercase
  // first under ICU). V8's stable sort keeps any remaining exact ties in insertion order.
  out.sort((a, b) => {
    const folded = a.label.toLowerCase().localeCompare(b.label.toLowerCase());
    return folded !== 0 ? folded : a.label.localeCompare(b.label);
  });

  const lines = out.slice(0, HOUSEHOLD_MAX).map((l) => l.text);
  if (out.length > HOUSEHOLD_MAX) {
    lines.push(`- …and ${out.length - HOUSEHOLD_MAX} more (see the household settings page)`);
  }
  return `${lines.join("\n")}\n\n${guidanceParagraph(homeKeysPath)}`;
}
