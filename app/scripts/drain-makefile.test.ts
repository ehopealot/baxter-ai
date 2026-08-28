import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const makefile = readFileSync(join(import.meta.dirname, "..", "..", "Makefile"), "utf8");

test("drain loop prints a zero-lease predicate value for its shell comparison", () => {
  assert.match(makefile, /process\.stdout\.write\(JSON\.parse\(s\)\.leaseCount===0\?\\"0\\":\\"1\\"\)/);
  assert.match(makefile, /status="\$\$\(\$\(DRAIN_CLI\) status\)" \|\| status=/);
});

test("run confirms containers started with intake open after startup", () => {
  const recipe = makefile.match(/^run:.*\n((?:\t.*\n)+)/m)?.[1];
  assert.ok(recipe, "expected a run recipe");
  const clear = recipe.indexOf("$(DRAIN_CLI) clear");
  const startup = recipe.indexOf("$(COMPOSE) up -d");
  const summary = recipe.indexOf("Baxter up: surfaces");
  const confirmation = recipe.indexOf("Baxter started: containers started and intake open");
  assert.ok(clear >= 0 && clear < startup);
  assert.ok(startup >= 0 && startup < summary);
  assert.ok(summary >= 0 && summary < confirmation);
  assert.match(recipe, /@echo "Baxter started: containers started and intake open"\n$/);
});
