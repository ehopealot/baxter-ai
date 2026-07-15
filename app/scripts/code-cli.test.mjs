import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, buildRequestBody, formatResult } from "./code-cli.mjs";

test("parseArgs reads lang and --file", () => {
  assert.deepEqual(parseArgs(["python"]), { lang: "python", file: null });
  assert.deepEqual(parseArgs(["node", "--file", "s.js"]), { lang: "node", file: "s.js" });
});

test("parseArgs rejects a value-less --file (dangling or empty)", () => {
  assert.throws(() => parseArgs(["python", "--file"]), /--file requires a path/);
  assert.throws(() => parseArgs(["python", "--file", ""]), /--file requires a path/);
});

test("parseArgs rejects unknown arguments (e.g. a positional path)", () => {
  assert.throws(() => parseArgs(["python", "script.py"]), /unknown argument/);
  assert.throws(() => parseArgs(["node", "--bogus"]), /unknown argument/);
});

test("buildRequestBody assembles a codapi /v1/exec request", () => {
  assert.deepEqual(buildRequestBody({ sandbox: "python", content: "print(1)", boundary: undefined }), {
    sandbox: "python",
    command: "run",
    files: { "": "print(1)" },
  });
  const withBoundary = buildRequestBody({ sandbox: "python", content: "print(1)", boundary: "B" });
  assert.equal(withBoundary.files[".artifact_boundary"], "B");
});

test("formatResult surfaces stdout, stderr, and ok", () => {
  const out = formatResult({ ok: true, stdout: "4\n", stderr: "" });
  assert.match(out, /^4/);
  assert.match(out, /\[ok\]/);
  const err = formatResult({ ok: false, stdout: "", stderr: "boom\n" });
  assert.match(err, /\[stderr\]\nboom/);
  assert.match(err, /\[error\]/);
});

import { sanitizeArtifactName, parseArtifacts, formatBytes } from "./code-cli.mjs";

test("sanitizeArtifactName keeps a basename, rejects traversal/absolute/empty", () => {
  assert.equal(sanitizeArtifactName("chart.png"), "chart.png");
  assert.equal(sanitizeArtifactName("my chart.png"), "my chart.png");
  for (const bad of ["", ".", "..", "../x", "/etc/passwd", "a/b.png", "..\\x"]) {
    assert.throws(() => sanitizeArtifactName(bad), /invalid artifact name/);
  }
});

test("sanitizeArtifactName rejects NUL bytes, control chars, and overlong names", () => {
  assert.throws(() => sanitizeArtifactName("a\x00b.png"), /invalid artifact name/);
  assert.throws(() => sanitizeArtifactName("x".repeat(300)), /invalid artifact name/);
  assert.throws(() => sanitizeArtifactName("a\nb.png"), /invalid artifact name/);
});

test("parseArtifacts splits program output from framed artifacts", () => {
  const B = "BOUND-abc";
  const b64 = Buffer.from("hello").toString("base64");
  const stdout = `line1\nline2\n\n${B} ARTIFACT 5 chart.png\n${b64}\n${B} END\n`;
  const r = parseArtifacts(stdout, B);
  assert.equal(r.output.trimEnd(), "line1\nline2");
  assert.equal(r.artifacts.length, 1);
  assert.equal(r.artifacts[0].name, "chart.png");
  assert.equal(r.artifacts[0].size, 5);
  assert.equal(r.artifacts[0].b64, b64);
  assert.equal(r.tooBig.length, 0);
});

test("parseArtifacts records TOOBIG frames and handles no artifacts", () => {
  const B = "BOUND-abc";
  assert.deepEqual(parseArtifacts("just output\n", B), { output: "just output\n", artifacts: [], tooBig: [], malformed: 0 });
  const r = parseArtifacts(`\n${B} TOOBIG 99999999 big.bin\n`, B);
  assert.deepEqual(r.tooBig, [{ name: "big.bin", size: 99999999 }]);
});

test("parseArtifacts is not fooled by output that resembles a frame but lacks the real boundary", () => {
  const B = "BOUND-secret";
  const stdout = `FAKE ARTIFACT 5 evil.png\n${Buffer.from("x").toString("base64")}\nFAKE END\n`;
  const r = parseArtifacts(stdout, B);
  assert.equal(r.artifacts.length, 0);
  assert.match(r.output, /FAKE ARTIFACT/); // stays in program output, not parsed
});

test("parseArtifacts marks a truncated frame (missing END) as malformed, not an artifact", () => {
  const B = "BOUND-abc";
  const b64 = Buffer.from("hello").toString("base64");
  const stdout = `${B} ARTIFACT 5 chart.png\n${b64}\n`; // no END line
  const r = parseArtifacts(stdout, B);
  assert.equal(r.artifacts.length, 0);
  assert.equal(r.malformed, 1);
});

test("parseArtifacts marks a forged newline-in-name frame as malformed, and a following well-formed frame still parses", () => {
  const B = "BOUND-abc";
  const badB64 = Buffer.from("x").toString("base64");
  const goodB64 = Buffer.from("hello").toString("base64");
  // Forged header: filename contains a real newline, splitting the header
  // across two lines -- the base64/END that "should" follow the real header
  // never lines up, so this must be rejected rather than silently accepted
  // with a mangled name.
  const stdout = `${B} ARTIFACT 5 evil\nX\n${badB64}\n${B} END\n${B} ARTIFACT 5 good.png\n${goodB64}\n${B} END\n`;
  const r = parseArtifacts(stdout, B);
  assert.ok(r.malformed >= 1);
  assert.equal(r.artifacts.length, 1);
  assert.equal(r.artifacts[0].name, "good.png");
  assert.equal(r.artifacts[0].b64, goodB64);
});
