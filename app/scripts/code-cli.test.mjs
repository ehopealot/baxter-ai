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
