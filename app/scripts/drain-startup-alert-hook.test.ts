import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const core = join(import.meta.dirname, "..", "..");
const readCore = (path: string) => readFileSync(join(core, path), "utf8");

test("every startup path loads the drain hook as a relative Node import", () => {
  const launchers = [readCore("compose.yaml"), readCore("app/Dockerfile"), readCore("Makefile")];
  for (const launcher of launchers) assert.doesNotMatch(launcher, /--import scripts\/drain-startup-alert-hook\.ts/);
  assert.match(readCore("compose.yaml"), /--import \.\/scripts\/drain-startup-alert-hook\.ts scripts\/discord-bot\.ts/);
  assert.match(readCore("compose.yaml"), /--import \.\/scripts\/drain-startup-alert-hook\.ts scripts\/light-bot\.ts/);
  assert.match(readCore("app/Dockerfile"), /"--import", "\.\/scripts\/drain-startup-alert-hook\.ts"/);
  assert.match(readCore("Makefile"), /--import \.\/scripts\/drain-startup-alert-hook\.ts scripts\/discord-bot\.ts/);
});
