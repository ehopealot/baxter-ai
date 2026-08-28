import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const makefile = readFileSync(join(import.meta.dirname, "..", "..", "Makefile"), "utf8");

test("drain loop prints a zero-lease predicate value for its shell comparison", () => {
  assert.match(makefile, /process\.stdout\.write\(JSON\.parse\(s\)\.leaseCount===0\?\\"0\\":\\"1\\"\)/);
  assert.match(makefile, /status="\$\$\(\$\(DRAIN_CLI\) status\)" \|\| status=/);
});
