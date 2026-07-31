import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordUsage } from "./usage-store.ts";

// Resolve the CLI relative to THIS test file (the repo isn't always at /app -- CI
// checks out elsewhere) and run it with the same node, no cwd. Mirrors
// calendar-cli.test.ts / memory-cli.test.ts.
const CLI = fileURLToPath(new URL("./usage-cli.ts", import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), "usagecli-"));
const env = { ...process.env, USAGE_DIR_OVERRIDE: DIR, BAXTER_CREDIT_BUDGET_USD: "5" };
process.env.USAGE_DIR_OVERRIDE = DIR;
recordUsage({ t: Date.now(), surface: "discord", model: "m", cost: 0.5, inTok: 10, outTok: 2, src: "openrouter", logId: "a" });

test("usage-cli json emits the summary shape", () => {
  const out = execFileSync(process.execPath, [CLI, "json"], { env, encoding: "utf8" });
  const s = JSON.parse(out);
  assert.equal(s.budget, 5);
  assert.ok(Math.abs(s.spent - 0.5) < 1e-9);
  assert.ok(s.byModel.m && s.bySurface.discord);
});

test("usage-cli show renders a spent line; bare (no arg) defaults to show", () => {
  const out = execFileSync(process.execPath, [CLI], { env, encoding: "utf8" });
  assert.match(out, /spent:/);
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
