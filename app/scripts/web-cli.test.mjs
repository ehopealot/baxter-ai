// Unit tests for web-cli's pure helpers (no network): the URL guard, HTML->text
// conversion, entity decoding, title extraction, and DuckDuckGo result parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardUrl, decodeEntities, htmlToText, extractTitle, ddgRealUrl, parseDdgResults } from "./web-cli.mjs";

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
  ]) {
    assert.throws(() => guardUrl(u), /internal\/loopback host/, `should refuse ${u}`);
  }
  // a public IP / host in the same 172 range but outside 16-31 is fine
  assert.ok(guardUrl("http://172.32.0.1/x"));
  assert.ok(guardUrl("https://172.15.0.1/x"));
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

test("ddgRealUrl decodes the /l/?uddg= wrapper and passes bare urls through", () => {
  assert.equal(
    ddgRealUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1&rut=x"),
    "https://example.com/page?a=1",
  );
  assert.equal(ddgRealUrl("https://example.org/direct"), "https://example.org/direct");
});

test("parseDdgResults extracts title/url/snippet and decodes wrapped links", () => {
  const html = `
    <div class="result results_links">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fwebhooks">Webhook &amp; limits</a>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Discord caps webhooks at 30/min per channel.</a>
    </div>
    <div class="result results_links">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Ftwo">Second</a>
    </div>`;
  const r = parseDdgResults(html, 8);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { title: "Webhook & limits", url: "https://docs.example.com/webhooks", snippet: "Discord caps webhooks at 30/min per channel." });
  assert.equal(r[1].url, "https://example.org/two");
  assert.equal(r[1].snippet, "");
});

test("parseDdgResults returns [] when the page has no result blocks (blocked/empty)", () => {
  assert.deepEqual(parseDdgResults("<html><body>If this error persists...</body></html>"), []);
});

test("parseDdgResults honors the limit", () => {
  const block = (i) => `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fe.com%2F${i}">R${i}</a>`;
  const html = [1, 2, 3, 4, 5].map(block).join("\n");
  assert.equal(parseDdgResults(html, 3).length, 3);
});
