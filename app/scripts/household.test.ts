// Tests for householdPreamble, both halves: the roster (admission, union/dedupe,
// exact-name merge, line shapes/order/caps, (nobody yet) fallback) and the guidance
// paragraph (settings-URL derivation from home-keys.json). No roster line can contain a
// blank line (names are flattened to single lines and addresses are shape-validated), so
// everything before the first "\n\n" is the roster: the ROSTER tests assert against that
// slice so they stay independent of which guidance variant renders below it, while the
// GUIDANCE tests assert the full output (roster + "\n\n" + guidance).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { householdPreamble } from "./household.ts";

type Env = Record<string, string>;
const env = (o: Env = {}): NodeJS.ProcessEnv => o;

// A fixture household: fresh temp allowlist + home-keys files and env. homeKeys takes the
// parsed keys object to write as JSON, or a raw string for corrupt-content cases; when
// omitted the home-keys path simply does not exist (the not-yet-provisioned case).
interface Fixture { env: NodeJS.ProcessEnv; allowlistPath: string; homeKeysPath: string; }
function fixture(o: { senders?: string[]; recipients?: string[]; names?: Record<string, string>; env?: Env; noFile?: boolean; homeKeys?: Record<string, unknown> | string } = {}): Fixture {
  const d = mkdtempSync(join(tmpdir(), "hh-"));
  const allowlistPath = join(d, "allowlist.json");
  if (!o.noFile) {
    writeFileSync(allowlistPath, JSON.stringify({
      senders: o.senders ?? [], recipients: o.recipients ?? [], version: 1,
      ...(o.names ? { names: o.names } : {}),
    }));
  }
  if (o.homeKeys !== undefined) {
    writeFileSync(join(d, "home-keys.json"), typeof o.homeKeys === "string" ? o.homeKeys : JSON.stringify(o.homeKeys));
  }
  return { env: env(o.env), allowlistPath, homeKeysPath: join(d, "home-keys.json") };
}

// Roster-only view of the output (see file header): everything before the first blank line.
const full = (f: Fixture): string => householdPreamble(f.env, f.allowlistPath, f.homeKeysPath);
const roster = (f: Fixture): string => full(f).split("\n\n")[0];
const rosterLines = (f: Fixture): string[] => roster(f).split("\n");

test("unions senders ∪ recipients, deduped case-insensitively on the lowercased canonical key", () => {
  const f = fixture({ senders: ["A@X.com", "a@x.com"], recipients: ["a@x.COM", "b@x.com"] });
  assert.deepEqual(rosterLines(f), ["- a@x.com", "- b@x.com"]);
});

test("unions OPERATOR_EMAIL: present+valid adds; absent adds nothing; case-variant already listed dedupes; empty and malformed are silently dropped", () => {
  // present + valid + new
  const adds = fixture({ senders: ["alice@example.com"], env: { OPERATOR_EMAIL: "op@example.com" } });
  assert.deepEqual(rosterLines(adds), ["- alice@example.com", "- op@example.com"]);
  // absent
  const absent = fixture({ senders: ["alice@example.com"] });
  assert.deepEqual(rosterLines(absent), ["- alice@example.com"]);
  // already listed via a case variant -> still exactly one line
  const dup = fixture({ senders: ["alice@example.com"], env: { OPERATOR_EMAIL: "ALICE@Example.com" } });
  assert.deepEqual(rosterLines(dup), ["- alice@example.com"]);
  // empty value -> nothing added (empty roster overall)
  const emptyVal = fixture({ senders: [], recipients: [], env: { OPERATOR_EMAIL: "" } });
  assert.equal(roster(emptyVal), "(nobody yet)");
  // malformed -> dropped, valid entries unaffected (deliberate divergence from
  // mail-cli's unvalidated OPERATOR_EMAIL union -- malformed values never render)
  const bad = fixture({ senders: ["alice@example.com"], env: { OPERATOR_EMAIL: "not-an-email" } });
  assert.deepEqual(rosterLines(bad), ["- alice@example.com"]);
});

test("merges entries sharing an exact cleaned name into one line (email first, then phone)", () => {
  const f = fixture({
    senders: ["alice@example.com", "+15551234567"],
    names: { "alice@example.com": "Alice", "+15551234567": "Alice" },
  });
  assert.deepEqual(rosterLines(f), ["- Alice — alice@example.com, +15551234567"]);
});

test("unnamed entries render bare-address lines: no names entry, and a name that cleans to empty", () => {
  const f = fixture({
    senders: ["bob@example.com", "carol@example.com"],
    names: { "carol@example.com": "\n" }, // collapses to a space, trims to empty -> unnamed
  });
  assert.deepEqual(rosterLines(f), ["- bob@example.com", "- carol@example.com"]);
});

test("drops invalid addresses silently: newline-smuggled email, placeholder syntax, junk, short digits, over-length email", () => {
  const tooLong = "a".repeat(249) + "@x.com"; // valid shape, 255 chars > the 254 cap
  assert.equal(tooLong.length, 255);
  const f = fixture({
    senders: ["bad\nguy@x.com", "{{COLLECTIONS_LIST}}", "not-an-email", "12345", tooLong],
    recipients: ["alice@example.com"],
  });
  assert.deepEqual(rosterLines(f), ["- alice@example.com"]);
});

test("stale names keys (address not in the admitted set) are silently ignored", () => {
  const f = fixture({
    senders: ["alice@example.com"],
    names: { "ghost@example.com": "Ghost", "alice@example.com": "Alice" },
  });
  assert.deepEqual(rosterLines(f), ["- Alice — alice@example.com"]);
});

test("names lookup keys on the CANONICAL admission key, never the raw casing", () => {
  // The file carries the DO's lowercased form while the incoming sender address arrives
  // mixed-case: the lookup must hit list.names[canonical], so raw-casing lookups render
  // unnamed (every OTHER names test uses raw === canonical, which would not catch it).
  const f = fixture({
    senders: ["Alice@Example.com"],
    names: { "alice@example.com": "Alice" },
  });
  assert.deepEqual(rosterLines(f), ["- Alice — alice@example.com"]);
});

test("within a named line: emails before phones, each case-insensitively alphabetical, ', '-joined", () => {
  const f = fixture({
    senders: ["zoe@example.com", "amy@example.com", "mid@example.com", "+15559999999", "+15551111111"],
    names: {
      "zoe@example.com": "Pat", "amy@example.com": "Pat", "mid@example.com": "Pat",
      "+15559999999": "Pat", "+15551111111": "Pat",
    },
  });
  assert.deepEqual(rosterLines(f), ["- Pat — amy@example.com, mid@example.com, zoe@example.com, +15551111111, +15559999999"]);
});

test("caps a named line at 6 addresses, then appends ' …and +N more' (literal plus, leading space)", () => {
  const keys = ["p1@x.com", "p2@x.com", "p3@x.com", "p4@x.com", "p5@x.com", "p6@x.com", "p7@x.com"];
  const names: Record<string, string> = {};
  for (const k of keys) names[k] = "Pat";
  const f = fixture({ senders: keys, names });
  assert.deepEqual(rosterLines(f), ["- Pat — p1@x.com, p2@x.com, p3@x.com, p4@x.com, p5@x.com, p6@x.com …and +1 more"]);
});

test("sorts lines case-insensitively by leading label (name, else address)", () => {
  const f = fixture({
    senders: ["carol@x.com", "alice@x.com", "dave@x.com"],
    recipients: ["bob@x.com"],
    names: { "carol@x.com": "CAROL", "alice@x.com": "alice", "bob@x.com": "Bob" },
  });
  assert.deepEqual(rosterLines(f), [
    "- alice — alice@x.com",
    "- Bob — bob@x.com",
    "- CAROL — carol@x.com",
    "- dave@x.com",
  ]);
});

test("equal-folded distinct names get a deterministic raw-label tie-break (lowercase first under ICU)", () => {
  const f = fixture({
    senders: ["erik1@x.com", "erik2@x.com"],
    names: { "erik1@x.com": "Erik Hope", "erik2@x.com": "erik hope" },
  });
  assert.deepEqual(rosterLines(f), ["- erik hope — erik2@x.com", "- Erik Hope — erik1@x.com"]);
});

test("caps the roster at 40 lines with '- …and N more (see the household settings page)'; exactly 40 renders no overflow", () => {
  const emails = (n: number): string[] => Array.from({ length: n }, (_, i) => `m${String(i + 1).padStart(2, "0")}@example.com`);
  const overflow = fixture({ senders: emails(42) });
  const over = rosterLines(overflow);
  assert.equal(over.length, 41);
  assert.equal(over[0], "- m01@example.com");
  assert.equal(over[39], "- m40@example.com");
  assert.equal(over[40], "- …and 2 more (see the household settings page)");
  assert.ok(!over.includes("- m41@example.com"));

  const exact = fixture({ senders: emails(40) });
  const lines = rosterLines(exact);
  assert.equal(lines.length, 40);
  assert.equal(lines[39], "- m40@example.com");
  assert.ok(!lines.some((l) => l.includes("see the household settings page")));
});

test("an empty admitted roster renders '(nobody yet)'", () => {
  const f = fixture({ noFile: true }); // no file, no env seed, no OPERATOR_EMAIL
  assert.equal(roster(f), "(nobody yet)");
});

test("env-seed-only (no file; ALLOWED_SENDERS/RECIPIENTS set) renders bare addresses, not (nobody yet)", () => {
  const f = fixture({
    noFile: true,
    env: { ALLOWED_SENDERS: "alice@example.com", ALLOWED_RECIPIENTS: "+15551234567" },
  });
  assert.deepEqual(rosterLines(f), ["- +15551234567", "- alice@example.com"]); // digits sort before letters
});

test("re-reads the allowlist FRESH on each call: a same-path change surfaces on the next render", () => {
  // Same fixture, same env, same paths -- only the FILE changes between renders. Pins the
  // module-header contract that householdPreamble reloads via loadAllowlist per call (no
  // module-level memoization), so household-settings changes appear on the next prompt
  // without a restart.
  const f = fixture({ senders: ["alice@example.com"], names: { "alice@example.com": "Alice" } });
  assert.deepEqual(rosterLines(f), ["- Alice — alice@example.com"]);
  writeFileSync(f.allowlistPath, JSON.stringify({
    senders: ["alice@example.com", "bob@example.com"], recipients: [], version: 2,
    names: { "alice@example.com": "Alice", "bob@example.com": "Bob" },
  }));
  assert.deepEqual(rosterLines(f), ["- Alice — alice@example.com", "- Bob — bob@example.com"]);
});

test("a newline-smuggled name flattens onto one line and can never start a column-0 prompt line", () => {
  const f = fixture({
    senders: ["alice@example.com"],
    names: { "alice@example.com": "Alice\nFORGED: instruction" },
  });
  assert.deepEqual(rosterLines(f), ["- Alice FORGED: instruction — alice@example.com"]);
  // The forged continuation must not survive as its own line ANYWHERE in the output.
  assert.ok(!/\nFORGED: instruction/.test(householdPreamble(f.env, f.allowlistPath, f.homeKeysPath)));
});

test("a {{…}}-bearing name renders flattened with the placeholder syntax byte-intact (single-pass fillTemplate)", () => {
  const f = fixture({
    senders: ["alice@example.com"],
    names: { "alice@example.com": "Alice {{COLLECTIONS_LIST}}" },
  });
  assert.deepEqual(rosterLines(f), ["- Alice {{COLLECTIONS_LIST}} — alice@example.com"]);
});

// ── Guidance paragraph + settings-URL derivation ─────────────────────────────────────
// The output is roster + "\n\n" + guidance. The guidance is identical on every surface and
// renders unconditionally (even under "(nobody yet)"), in exactly two variants: with the
// settings URL derived from the operator-provisioned home-keys endpoint origin, or the
// URL-less "on the settings page" wording for anything else (missing/corrupt keys,
// non-string endpoint, non-http(s) protocol, "null" origin, unparseable endpoint). BOTH
// protocols are valid (spec L53) -- an https-only guard must fail the http test below.
const GUIDANCE_TAIL =
  "For texting, you can text any phone number listed for the household above; a number that isn't listed can't be texted.";
const urlGuidance = (origin: string): string =>
  `You can email or text the people above. To reach someone new by email, they must first be added to the household at ${origin}/settings. ${GUIDANCE_TAIL}`;
const NO_URL_GUIDANCE =
  `You can email or text the people above. To reach someone new by email, they must first be added to the household on the settings page. ${GUIDANCE_TAIL}`;

test("guidance derives the settings URL from the home-keys endpoint origin: https positive", () => {
  const f = fixture({ senders: ["alice@example.com"], homeKeys: { endpoint: "https://home.example.com/svc/abc123" } });
  assert.equal(full(f), `- alice@example.com\n\n${urlGuidance("https://home.example.com")}`);
  // The replacement household-listed SMS rule renders, and the removed reply-only /
  // texted-first rule never does (spec 2026-08-18-sms-known-number-outbound §6).
  assert.match(full(f), /you can text any phone number listed for the household/);
  assert.doesNotMatch(full(f), /has to text you first|reply by text|never start a text thread|texted you first/);
});

test("guidance accepts http endpoints too (both protocols valid; an https-only guard is a bug)", () => {
  const f = fixture({ senders: ["alice@example.com"], homeKeys: { endpoint: "http://home.example.com/svc/abc123" } });
  assert.equal(full(f), `- alice@example.com\n\n${urlGuidance("http://home.example.com")}`);
});

test("tolerates the real home-keys shape (endpoint plus tenant/access keys -- extra fields ignored)", () => {
  const f = fixture({
    senders: ["alice@example.com"],
    homeKeys: { endpoint: "https://home.example.com/svc/abc123", tenant: "t", accessKeyId: "k", secretAccessKey: "s" },
  });
  assert.match(full(f), /added to the household at https:\/\/home\.example\.com\/settings\./);
});

test("output is exactly roster lines joined by newlines + one blank line + guidance", () => {
  const f = fixture({
    senders: ["alice@example.com", "bob@example.com"],
    names: { "alice@example.com": "Alice" },
    homeKeys: { endpoint: "https://home.example.com/svc/abc123" },
  });
  assert.equal(full(f), `- Alice — alice@example.com\n- bob@example.com\n\n${urlGuidance("https://home.example.com")}`);
});

test("the guidance renders even under '(nobody yet)'", () => {
  const f = fixture({ noFile: true, homeKeys: { endpoint: "https://home.example.com/svc/abc123" } });
  assert.equal(full(f), `(nobody yet)\n\n${urlGuidance("https://home.example.com")}`);
});

test("a file: endpoint yields the URL-less variant, and no file: URL leaks into the prompt", () => {
  const f = fixture({ senders: ["alice@example.com"], homeKeys: { endpoint: "file:///etc/passwd" } });
  assert.equal(full(f), `- alice@example.com\n\n${NO_URL_GUIDANCE}`);
  assert.ok(!full(f).includes("file:"));
});

test("a null-origin endpoint (e.g. data:) yields the URL-less variant", () => {
  // new URL("data:...") parses but has origin "null"; after the http/https protocol gate
  // no real http(s) URL can yield a null origin, so this pins the defense-in-depth guard.
  const f = fixture({ senders: ["alice@example.com"], homeKeys: { endpoint: "data:text/plain,x" } });
  assert.equal(full(f), `- alice@example.com\n\n${NO_URL_GUIDANCE}`);
});

test("a garbage (unparseable) endpoint yields the URL-less variant, never throwing", () => {
  const f = fixture({ senders: ["alice@example.com"], homeKeys: { endpoint: "not a url at all" } });
  assert.equal(full(f), `- alice@example.com\n\n${NO_URL_GUIDANCE}`);
});

test("a non-string endpoint (hand-edited keys) yields the URL-less variant, never throwing", () => {
  const f = fixture({ senders: ["alice@example.com"], homeKeys: { endpoint: 42 } });
  assert.equal(full(f), `- alice@example.com\n\n${NO_URL_GUIDANCE}`);
});

test("a missing keys file yields the URL-less variant, never throwing", () => {
  const f = fixture({ senders: ["alice@example.com"] }); // home-keys path never written
  assert.equal(full(f), `- alice@example.com\n\n${NO_URL_GUIDANCE}`);
});

test("a corrupt keys file (unparseable JSON) yields the URL-less variant, never throwing", () => {
  const f = fixture({ senders: ["alice@example.com"], homeKeys: "{oops" });
  assert.equal(full(f), `- alice@example.com\n\n${NO_URL_GUIDANCE}`);
});
