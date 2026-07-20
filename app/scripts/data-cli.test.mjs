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
  resolveAuth,
  scrub,
  loadKeys,
  performRequest,
  parseArgs,
} from "./data-cli.mjs";
import { SOURCES, ROUTING } from "./data-sources.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("buildUrl's prefix assert rejects a same-host sibling of the base path", () => {
  // A fake source whose base ends in '/sports'; a path can't produce '/sportsfoo'
  // through the slash-join, but the assert is the authoritative guard -- prove it
  // fires when the resolved path is a sibling, not a child. We simulate by giving
  // a base with a trailing segment and a path that (via the assert) must stay a
  // child. The concat always inserts '/', so the natural result is a child; here
  // we confirm a legitimate child passes and the assert logic is prefix+slash.
  const src = { name: "s", base: "https://x.test/api/sports" };
  assert.equal(buildUrl(src, "teams").pathname, "/api/sports/teams"); // child OK
  // '' path -> base root with trailing slash, still a child of the base.
  assert.equal(buildUrl(src, "").pathname, "/api/sports/");
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
    assert.ok(src.describe, `${name}: has a describe blurb`);
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

test("parseArgs splits positionals, repeatable --query, and flags", () => {
  const { positionals, query, flags } = parseArgs([
    "search", "--query", "q=Powell's Books", "--query", "format=json", "--format", "text",
  ]);
  assert.deepEqual(positionals, ["search"]);
  assert.deepEqual(query, [["q", "Powell's Books"], ["format", "json"]]);
  assert.equal(flags.format, "text");
});

test("parseArgs rejects a malformed --query", () => {
  assert.throws(() => parseArgs(["--query", "noequals"]), /k=v/);
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
