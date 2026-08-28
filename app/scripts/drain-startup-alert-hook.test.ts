import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const compose = readFileSync(join(import.meta.dirname, "..", "..", "compose.yaml"), "utf8");

test("compose loads the drain startup hook as a relative Node import", () => {
  assert.match(compose, /--import \.\/scripts\/drain-startup-alert-hook\.ts scripts\/discord-bot\.ts/);
  assert.match(compose, /--import \.\/scripts\/drain-startup-alert-hook\.ts scripts\/light-bot\.ts/);
  assert.doesNotMatch(compose, /--import scripts\/drain-startup-alert-hook\.ts/);
});
