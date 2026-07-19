// Unit tests for web-cli's pure helpers (no network): the URL guard, HTML->text
// conversion, entity decoding, and title extraction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardUrl, decodeEntities, htmlToText, extractTitle } from "./web-cli.mjs";

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
