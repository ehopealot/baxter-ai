// Focused tests for data-cli.mjs -- pure logic + the security core, no network.
// Importing is safe: the CLI dispatch is guarded behind the import.meta.url/argv
// check, so importing doesn't run it. The network path (performRequest) takes an
// injectable `deps.fetch`, so its host-lock / key-injection / redirect behaviour
// is exercised with a stub, never a real request.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getSource,
  buildUrl,
  assertConfined,
  resolveAuth,
  scrub,
  loadKeys,
  performRequest,
  parseArgs,
  renderDescribe,
} from "./data-cli.mjs";
import { SOURCES, ROUTING } from "./data-sources.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// A source whose base carries a non-empty root path -- the interesting case for
// the path-prefix assert (espn's real shape).
const ESPN = SOURCES.espn;

// A stub fetch: records the call and returns a Response-like object readCapped
// can consume (no `body` -> it uses arrayBuffer()).
function stubFetch({ status = 200, type = "default", url = "", body = "" } = {}) {
  const calls = [];
  const fn = async (u, opts) => {
    calls.push({ url: u, opts });
    return {
      status,
      type,
      url,
      headers: new Map(),
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  };
  fn.calls = calls;
  return fn;
}

// --- path sanitization (the security core) ---

test("buildUrl builds a normal nested path under the base", () => {
  const url = buildUrl(ESPN, "basketball/nba/scoreboard");
  assert.equal(url.origin, "https://site.api.espn.com");
  assert.equal(url.pathname, "/apis/site/v2/sports/basketball/nba/scoreboard");
});

test("buildUrl appends --query params as encoded values", () => {
  const url = buildUrl(ESPN, "football/nfl/scoreboard", [["dates", "20260215"], ["q", "a b"]]);
  assert.equal(url.searchParams.get("dates"), "20260215");
  assert.equal(url.searchParams.get("q"), "a b");
  assert.ok(url.search.includes("a+b") || url.search.includes("a%20b")); // encoded, not raw space
});

test("buildUrl rejects a scheme / host in the path", () => {
  assert.throws(() => buildUrl(ESPN, "http://evil.com/x"), /scheme or host/);
  assert.throws(() => buildUrl(ESPN, "//evil.com/x"), /scheme or host/);
});

test("buildUrl rejects a leading slash (host reset)", () => {
  assert.throws(() => buildUrl(ESPN, "/etc/passwd"), /no leading/);
});

test("buildUrl rejects literal and percent-encoded traversal", () => {
  assert.throws(() => buildUrl(ESPN, "a/../../etc"), /'\.\.'/);
  // %2e%2e would normalize to real dot-dot inside new URL(); the `%` bar stops it
  // before it ever gets there.
  assert.throws(() => buildUrl(ESPN, "a/%2e%2e/etc"), /'\?', '#' or '%'/);
});

test("buildUrl rejects ? and # (query/fragment must go through --query)", () => {
  assert.throws(() => buildUrl(ESPN, "scoreboard?limit=1000"), /'\?', '#' or '%'/);
  assert.throws(() => buildUrl(ESPN, "scoreboard#frag"), /'\?', '#' or '%'/);
});

test("buildUrl rejects backslashes and control chars", () => {
  assert.throws(() => buildUrl(ESPN, "a\\b"), /backslash/);
  assert.throws(() => buildUrl(ESPN, "ab"), /control character/);
});

test("buildUrl passes a legitimate child path and the empty (base-root) path", () => {
  const src = { name: "s", base: "https://x.test/api/sports" };
  assert.equal(buildUrl(src, "teams").pathname, "/api/sports/teams"); // child OK
  // '' path -> base root with trailing slash, still a child of the base.
  assert.equal(buildUrl(src, "").pathname, "/api/sports/");
});

test("assertConfined (the load-bearing check) rejects siblings and off-host URLs", () => {
  // buildUrl's slash-join means the reject-list makes a sibling/off-host URL
  // unreachable THROUGH buildUrl -- so test the authoritative assert directly
  // with hand-built URLs, exercising both reject branches.
  const base = "https://x.test/api/sports";
  assert.doesNotThrow(() => assertConfined(new URL("https://x.test/api/sports/teams"), base)); // child
  assert.doesNotThrow(() => assertConfined(new URL("https://x.test/api/sports"), base));       // exact base
  // Sibling: same host, path shares the prefix but isn't a child -> rejected by
  // the trailing-slash guard.
  assert.throws(() => assertConfined(new URL("https://x.test/api/sportsfoo"), base), /escaped source base/);
  // Off-host -> rejected by the origin check.
  assert.throws(() => assertConfined(new URL("https://evil.test/api/sports/teams"), base), /escaped source base/);
});

test("buildUrl handles a host-root base (nominatim, empty base path)", () => {
  const url = buildUrl(SOURCES.nominatim, "search", [["q", "Portland"], ["format", "json"]]);
  assert.equal(url.origin, "https://nominatim.openstreetmap.org");
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("format"), "json");
});

// --- auth resolution + scrubbing ---

test("resolveAuth returns nulls for a keyless source", () => {
  assert.deepEqual(resolveAuth(ESPN, null), { queryParam: null, header: null, keyValue: null });
});

test("resolveAuth injects a query-param key", () => {
  const src = { name: "fq", auth: { type: "query", param: "token", keyName: "FQ_KEY" } };
  const a = resolveAuth(src, { FQ_KEY: "SECRET123" });
  assert.deepEqual(a.queryParam, ["token", "SECRET123"]);
  assert.equal(a.header, null);
  assert.equal(a.keyValue, "SECRET123");
});

test("resolveAuth injects a header key", () => {
  const src = { name: "fh", auth: { type: "header", name: "X-Api-Key", keyName: "FH_KEY" } };
  const a = resolveAuth(src, { FH_KEY: "HSECRET" });
  assert.deepEqual(a.header, ["X-Api-Key", "HSECRET"]);
  assert.equal(a.queryParam, null);
});

test("resolveAuth throws (no request) when the key is missing", () => {
  const src = { name: "fq", auth: { type: "query", param: "token", keyName: "FQ_KEY" } };
  assert.throws(() => resolveAuth(src, {}), /needs key "FQ_KEY"/);
});

test("scrub redacts every secret value", () => {
  assert.equal(scrub("url?token=ABC123 and ABC123 again", ["ABC123"]), "url?token=[key] and [key] again");
  assert.equal(scrub("nothing here", ["ABC123"]), "nothing here");
  assert.equal(scrub("x", []), "x");
});

// --- network path (stubbed fetch): host lock, key injection, redirect lock ---

test("performRequest (query key): key rides the URL to the fixed host, scrubbed from output", async () => {
  const src = { name: "fq", base: "https://fake.test/api", auth: { type: "query", param: "token", keyName: "FQ_KEY" } };
  const auth = resolveAuth(src, { FQ_KEY: "SECRET123" });
  const url = buildUrl(src, "quote", [auth.queryParam]);
  const fetch = stubFetch({ body: "quote for SECRET123 echoed" }); // API echoes the key back
  const r = await performRequest(src, url, auth, { fetch });

  // Sent only to the fixed host, with the key present in the outgoing URL.
  assert.equal(fetch.calls.length, 1);
  const sent = new URL(fetch.calls[0].url);
  assert.equal(sent.origin, "https://fake.test");
  assert.equal(sent.searchParams.get("token"), "SECRET123");
  // Keyed -> manual redirect.
  assert.equal(fetch.calls[0].opts.redirect, "manual");
  // The key never appears in the emitted output (URL or body).
  assert.ok(!r.finalUrl.includes("SECRET123"), "key scrubbed from reported URL");
  assert.ok(!r.text.includes("SECRET123"), "key scrubbed from body");
  assert.match(r.text, /\[key\]/);
});

test("performRequest scrubs every encoding of the key from the reported URL and body", async () => {
  // A realistic key with reserved chars AND a space: the space makes the
  // form-urlencoded form (space->'+', what searchParams serializes into the
  // request URL) DIVERGE from encodeURIComponent (space->'%20'), so all three
  // secret variants are genuinely distinct and each gets exercised.
  const src = { name: "fq", base: "https://fake.test/api", auth: { type: "query", param: "token", keyName: "FQ_KEY" } };
  const rawKey = "abc+def/ghi=jkl mno";
  const uriEncoded = encodeURIComponent(rawKey);                              // ...jkl%20mno
  const formEncoded = new URLSearchParams([["k", rawKey]]).toString().slice(2); // ...jkl+mno
  assert.notEqual(uriEncoded, formEncoded, "space makes the two encoders diverge (else the test is weak)");

  const auth = resolveAuth(src, { FQ_KEY: rawKey });
  const url = buildUrl(src, "quote", [auth.queryParam]);
  // An API error body that echoes BOTH encoded forms of the request URL.
  const fetch = stubFetch({ body: `bad request: token=${formEncoded} (aka ${uriEncoded})` });
  const r = await performRequest(src, url, auth, { fetch });

  // None of the three forms survives in any emitted string.
  for (const s of [rawKey, uriEncoded, formEncoded]) {
    assert.ok(!r.finalUrl.includes(s), `finalUrl leaks ${s}`);
    assert.ok(!r.text.includes(s), `body leaks ${s}`);
  }
  assert.ok(r.finalUrl.includes("token=%5Bkey%5D") || r.finalUrl.includes("token=[key]"), "auth param redacted");
});

test("performRequest (header key): key goes in the header, not the URL", async () => {
  const src = { name: "fh", base: "https://fake.test/api", auth: { type: "header", name: "X-Api-Key", keyName: "FH_KEY" } };
  const auth = resolveAuth(src, { FH_KEY: "HSECRET" });
  const url = buildUrl(src, "quote");
  const fetch = stubFetch({ body: "ok" });
  await performRequest(src, url, auth, { fetch });
  assert.equal(fetch.calls[0].opts.headers["X-Api-Key"], "HSECRET");
  assert.ok(!fetch.calls[0].url.toString().includes("HSECRET"));
});

test("performRequest (keyed): a redirect is NOT followed, no key leaks", async () => {
  const src = { name: "fq", base: "https://fake.test/api", auth: { type: "query", param: "token", keyName: "FQ_KEY" } };
  const auth = resolveAuth(src, { FQ_KEY: "SECRET123" });
  const url = buildUrl(src, "quote", [auth.queryParam]);
  const fetch = stubFetch({ type: "opaqueredirect", status: 0 });
  await assert.rejects(performRequest(src, url, auth, { fetch }), (err) => {
    assert.match(err.message, /not following/);
    assert.ok(!err.message.includes("SECRET123"));
    return true;
  });
  assert.equal(fetch.calls.length, 1, "no second request issued");
});

test("performRequest (keyless): follows, but rejects a redirect off the source host", async () => {
  const src = { name: "kl", base: "https://good.test/api", auth: null };
  const auth = resolveAuth(src, null);
  const url = buildUrl(src, "thing");
  // fetch followed a redirect and the final res.url is a different host.
  const fetch = stubFetch({ url: "https://evil.test/x", body: "hi" });
  await assert.rejects(performRequest(src, url, auth, { fetch }), /off the source host/);
  assert.equal(fetch.calls[0].opts.redirect, "follow");
});

test("performRequest surfaces a non-2xx status with its (capped) body", async () => {
  const src = { name: "kl", base: "https://good.test/api", auth: null };
  const auth = resolveAuth(src, null);
  const url = buildUrl(src, "thing");
  const fetch = stubFetch({ status: 404, url: "https://good.test/api/thing", body: "not found" });
  const r = await performRequest(src, url, auth, { fetch });
  assert.equal(r.status, 404);
  assert.equal(r.text, "not found");
});

test("performRequest caps the body and flags truncation", async () => {
  const src = { name: "kl", base: "https://good.test/api", auth: null, cap: 10 };
  const auth = resolveAuth(src, null);
  const url = buildUrl(src, "thing");
  const fetch = stubFetch({ url: "https://good.test/api/thing", body: "0123456789ABCDEFGHIJ" });
  const r = await performRequest(src, url, auth, { fetch });
  assert.equal(r.text.length, 10);
  assert.equal(r.truncated, true);
});

// --- registry integrity + rendering + arg parse ---

test("every registry source has the required fields and a trailing-slash-free base", () => {
  for (const [name, src] of Object.entries(SOURCES)) {
    assert.equal(src.name, name, `${name}: name matches key`);
    assert.ok(src.base && !src.base.endsWith("/"), `${name}: base set, no trailing slash`);
    assert.ok(src.hint, `${name}: has a hint`);
    assert.doesNotThrow(() => new URL(src.base), `${name}: base parses`);
    if (src.auth) {
      assert.ok(["query", "header"].includes(src.auth.type), `${name}: known auth type`);
      assert.ok(src.auth.keyName, `${name}: auth has a keyName`);
    }
  }
  // routing hints point at real sources.
  for (const [, name] of ROUTING) assert.ok(SOURCES[name], `routing target ${name} exists`);
});

test("getSource resolves a known source and errors clearly on an unknown one", () => {
  assert.equal(getSource("espn").name, "espn");
  assert.throws(() => getSource("nope"), /unknown source "nope"/);
});

test("describe is a pointer to the per-source skill, with a bootstrap-if-missing path", () => {
  const out = renderDescribe(getSource("espn"));
  assert.match(out, /base: https:\/\/site\.api\.espn\.com/);
  assert.match(out, /keyless/);
  // Points at the conventional per-source skill name, both to open and to write.
  assert.match(out, /data-cli-espn/);
  assert.match(out, /Skill tool/);
  assert.match(out, /WRITE .*data-cli-espn.* as a learned skill/);
  // A keyed source describes the key as CLI-handled, never model-handled.
  const keyed = renderDescribe({ name: "fh", base: "https://x.test/api", auth: { type: "header", name: "X-Api-Key", keyName: "FH_KEY" }, hint: "x" });
  assert.match(keyed, /you never see or handle it/);
  assert.match(keyed, /data-cli-fh/);
});

test("parseArgs splits positionals, repeatable --query, and other flags", () => {
  const { positionals, query, flags } = parseArgs([
    "search", "--query", "q=Powell's Books", "--query", "format=json", "--limit", "5",
  ]);
  assert.deepEqual(positionals, ["search"]);
  assert.deepEqual(query, [["q", "Powell's Books"], ["format", "json"]]);
  // Generic --flag collection swallows an unknown flag rather than mangling it
  // into the path (no --format handling exists yet; parseArgs stays forward-safe).
  assert.equal(flags.limit, "5");
});

test("parseArgs rejects a malformed --query", () => {
  assert.throws(() => parseArgs(["--query", "noequals"]), /k=v/);
});

test("the CLI rejects an unknown flag loudly (before any request)", () => {
  // Runs the real dispatch: an unknown flag must error out with exit 1 BEFORE
  // resolveAuth/performRequest, so this needs no network.
  const cli = fileURLToPath(new URL("./data-cli.mjs", import.meta.url));
  let err;
  try {
    execFileSync("node", [cli, "espn", "scoreboard", "--limit", "5"], { stdio: "pipe" });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "expected a non-zero exit");
  assert.equal(err.status, 1);
  assert.match(String(err.stderr), /unknown flag --limit/);
});

// --- loadKeys ---

test("loadKeys returns {} for a missing file and parses a present one", () => {
  assert.deepEqual(loadKeys(join(tmpdir(), "definitely-absent-data-keys-xyz.json")), {});
  const dir = mkdtempSync(join(tmpdir(), "data-keys-"));
  const p = join(dir, "data-keys.json");
  writeFileSync(p, JSON.stringify({ FOO: "bar" }));
  assert.deepEqual(loadKeys(p), { FOO: "bar" });
  writeFileSync(p, "not json{");
  assert.throws(() => loadKeys(p), /not valid JSON/);
});
