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
  assert.deepEqual(buildRequestBody({ sandbox: "python", content: "print(1)" }), {
    sandbox: "python",
    command: "run",
    files: { "": "print(1)" },
  });
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
  assert.deepEqual(parseArtifacts("just output\n", B), { output: "just output\n", artifacts: [], tooBig: [] });
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
