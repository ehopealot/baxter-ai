// Unit tests for web-cli's pure helpers (no network): the URL guard, HTML->text
// conversion, entity decoding, and title extraction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardUrl, decodeEntities, htmlToText, extractTitle, formatSearchResults, performSearch } from "./web-cli.ts";

test("guardUrl accepts http/https and rejects other schemes", () => {
  assert.equal(guardUrl("https://example.com/x").hostname, "example.com");
  assert.equal(guardUrl("http://example.com").protocol, "http:");
  assert.throws(() => guardUrl("file:///etc/passwd"), /only http\/https/);
  assert.throws(() => guardUrl("data:text/html,hi"), /only http\/https/);
  assert.throws(() => guardUrl("not a url"), /invalid URL|only http/);
});

test("guardUrl refuses internal/loopback/private hosts", () => {
  for (const u of [
    "http://localhost/x",
    "http://127.0.0.1/x",
    "http://10.1.2.3/x",
    "http://192.168.0.5/x",
    "http://169.254.169.254/latest/meta-data",
    "http://172.16.5.5/x",
    "http://codapi:1313/v1/exec",
    "http://foo.local/x",
    "http://[::1]/x",
    "http://0.0.0.0/x",
    "http://0/x", // URL parser normalizes to 0.0.0.0
    "http://[::]/x",
    "http://[::ffff:127.0.0.1]/x", // IPv4-mapped IPv6 -> serialized ::ffff:7f00:1
    "http://[fe80::1]/x", // link-local
    "http://[fc00::1]/x", // ULA
  ]) {
    assert.throws(() => guardUrl(u), /internal\/loopback host/, `should refuse ${u}`);
  }
  // a public IP / host in the same 172 range but outside 16-31 is fine
  assert.ok(guardUrl("http://172.32.0.1/x"));
  assert.ok(guardUrl("https://172.15.0.1/x"));
  // real public domains whose first label looks like a private prefix must NOT be
  // blocked (the IPv4 checks are anchored to a full dotted quad)
  assert.ok(guardUrl("https://0.gravatar.com/x"));
  assert.ok(guardUrl("https://10.com/x"));
  assert.ok(guardUrl("https://127.net/x"));
  assert.ok(guardUrl("https://0.30000000000000004.com/"));
});

test("decodeEntities handles named, decimal, and hex entities", () => {
  assert.equal(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x2F;"), 'a & b <c> "d" \'e\' /');
  assert.equal(decodeEntities("&nbsp;x"), " x");
  assert.equal(decodeEntities("&notreal;"), "&notreal;"); // unknown named entity left intact
});

test("htmlToText strips scripts/styles/tags, decodes entities, and breaks blocks", () => {
  const html = `<html><head><title>T</title><style>.x{color:red}</style></head>
    <body><script>evil()</script><h1>Hi &amp; bye</h1><p>one</p><p>two</p><div>three</div></body></html>`;
  const txt = htmlToText(html);
  assert.doesNotMatch(txt, /evil\(\)/); // script gone
  assert.doesNotMatch(txt, /color:red/); // style gone
  assert.doesNotMatch(txt, /</); // no tags left
  assert.match(txt, /Hi & bye/); // entity decoded
  assert.deepEqual(txt.split("\n").map((l) => l.trim()).filter(Boolean), ["Hi & bye", "one", "two", "three"]);
});

test("extractTitle pulls and decodes the title", () => {
  assert.equal(extractTitle("<html><title>Rate &amp; limits</title></html>"), "Rate & limits");
  assert.equal(extractTitle("<html>no title</html>"), "");
});

// --- search (SearXNG) ---

// A partial Response double readCapped can consume (no body -> arrayBuffer
// fallback); records the requested URL. Mirrors data-cli.test's stub, cast
// through unknown (never any).
function stubFetch({ status = 200, body = "" }: { status?: number; body?: string } = {}) {
  const calls: string[] = [];
  const fn = (async (u: string | URL) => {
    calls.push(String(u));
    return { status, url: String(u), headers: new Map(), arrayBuffer: async () => new TextEncoder().encode(body).buffer } as unknown as Response;
  }) as unknown as ((u: string | URL, init?: RequestInit) => Promise<Response>) & { calls: string[] };
  fn.calls = calls;
  return fn;
}

test("formatSearchResults renders numbered title/url/snippet, decodes entities, strips tags, caps at max", () => {
  const json = { results: [
    { title: "First &amp; best", url: "https://a.test/1", content: "A <b>snippet</b> here" },
    { title: "Second", url: "https://b.test/2", content: "more" },
    { title: "Third", url: "https://c.test/3", content: "x" },
  ] };
  const out = formatSearchResults(json, "cats", 2);
  assert.match(out, /^Search: cats/);
  assert.match(out, /2 results from SearXNG/);
  assert.match(out, /1\. First & best/);        // entity decoded
  assert.match(out, /https:\/\/a\.test\/1/);
  assert.match(out, /A snippet here/);           // tags stripped
  assert.doesNotMatch(out, /Third/);             // capped at max=2
});

test("formatSearchResults handles no/absent results and missing fields", () => {
  assert.match(formatSearchResults({ results: [] }, "zzz"), /No results/);
  assert.match(formatSearchResults({}, "q"), /No results/);        // results key absent
  assert.match(formatSearchResults(null, "q"), /No results/);      // not even an object
  assert.match(formatSearchResults({ results: [{}] }, "q"), /1\. \(untitled\)/); // no title/url/content
});

test("formatSearchResults surfaces answers (string or {answer}) and suggestions", () => {
  const withStr = formatSearchResults({ answers: ["42 is the answer"], results: [{ title: "t", url: "u" }], suggestions: ["more cats", "kittens"] }, "q");
  assert.match(withStr, /Answer: 42 is the answer/);
  assert.match(withStr, /Related searches: more cats; kittens/);
  const withObj = formatSearchResults({ answers: [{ answer: "obj answer", url: "x" }], results: [{ title: "t", url: "u" }] }, "q");
  assert.match(withObj, /Answer: obj answer/);
});

test("performSearch builds the JSON search URL (trailing slash trimmed, query encoded) and formats the body", async () => {
  const fetch = stubFetch({ body: JSON.stringify({ results: [{ title: "Hit", url: "https://x.test/", content: "snip" }] }) });
  const out = await performSearch("hello world", { fetch, searxngUrl: "http://searxng:8080/" });
  assert.equal(fetch.calls[0], "http://searxng:8080/search?q=hello%20world&format=json");
  assert.match(out, /1\. Hit/);
  assert.match(out, /https:\/\/x\.test\//);
});

test("performSearch reports a misconfigured/erroring service on non-2xx", async () => {
  const fetch = stubFetch({ status: 403, body: "forbidden" });
  await assert.rejects(() => performSearch("q", { fetch }), /HTTP 403[\s\S]*settings\.yml/);
});

test("performSearch turns an unreachable service into an actionable error", async () => {
  const fetch = (async () => { throw new TypeError("fetch failed"); }) as unknown as (u: string | URL, init?: RequestInit) => Promise<Response>;
  await assert.rejects(() => performSearch("q", { fetch, searxngUrl: "http://searxng:8080" }), /could not reach SearXNG at http:\/\/searxng:8080[\s\S]*service running/);
});

test("performSearch surfaces the code of an empty-message AggregateError cause", async () => {
  // A dual-stack refusal (e.g. localhost -> ::1 + 127.0.0.1) wraps the errors in an
  // AggregateError whose message is "" -- the code branch must recover ECONNREFUSED.
  const cause = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });
  const fetch = (async () => { throw new TypeError("fetch failed", { cause }); }) as unknown as (u: string | URL, init?: RequestInit) => Promise<Response>;
  await assert.rejects(() => performSearch("q", { fetch, searxngUrl: "http://searxng:8080" }), /fetch failed: ECONNREFUSED/);
});

test("performSearch points at the settings fix when the body isn't JSON", async () => {
  const fetch = stubFetch({ body: "<html>not json</html>" });
  await assert.rejects(() => performSearch("q", { fetch }), /did not return JSON[\s\S]*search\.formats/);
});
