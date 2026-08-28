import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const appDir = join(import.meta.dirname, "..");
const coreDir = join(appDir, "..");
const readCore = (relative: string): string => readFileSync(join(coreDir, relative), "utf8");

test("the Discord voice surface has no implementation, image, or Compose target", () => {
  for (const source of ["scripts/voice-bot.ts", "scripts/voice-brain.ts"]) {
    assert.equal(existsSync(join(appDir, source)), false, `${source} must be removed`);
  }
  assert.doesNotMatch(readCore("app/package.json"), /@discordjs\/voice|opusscript|prism-media|@snazzah\/davey/);
  assert.doesNotMatch(readCore("app/Dockerfile"), /WITH_VOICE|whisper-builder|voice-[01]|piper|muzak/i);
  assert.doesNotMatch(readCore("compose.yaml"), /^\s{2}voice:/m);
  assert.doesNotMatch(readCore("Makefile"), /^voice:/m);
});

test("the validated surface set is passed into the light container", () => {
  assert.match(readCore("Makefile"), /BAXTER_SURFACES=\$\(BAXTER_SURFACES\)/);
  assert.match(readCore("compose.yaml"), /BAXTER_SURFACES: \$\{BAXTER_SURFACES\}/);
  assert.match(readCore("Makefile"), /^home: check-surfaces /m);
  assert.match(readCore("Makefile"), /^heartbeat: check-surfaces /m);
});
