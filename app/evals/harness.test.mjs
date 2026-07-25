// Offline unit tests for the harness's PURE pieces (no LLM, no runAgent). The
// end-to-end runScenario/runSuite are covered by the live smoke (run.mjs, gated on
// an API key), since they call a real model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doctorTools, allowedToolsFor, buildSlots, renderScenarioPrompt, passThreshold, formatTable,
} from "./harness.mjs";

test("doctorTools converts absolute `node <path>` grants to PATH-friendly ones + dedups", () => {
  const out = doctorTools("Bash(node /app/scripts/mail.mjs *) Bash(node /app/scripts/discord-cli.mjs *) Bash(discord-cli *) Bash(code-cli *) WebSearch Read");
  assert.ok(!/node /.test(out), "no absolute node-path grant survives");
  assert.ok(out.includes("Bash(mail *)"), "mail node-grant -> friendly Bash(mail *)");
  // discord-cli appeared as BOTH a node-path and a friendly grant -> exactly one now
  assert.equal((out.match(/Bash\(discord-cli \*\)/g) || []).length, 1, "deduped");
  assert.ok(out.includes("Bash(code-cli *)") && out.includes("Read")); // Bash groups + bare tokens survive
});

test("allowedToolsFor: PATH-friendly grants per surface, no absolute node grant, unknown throws", () => {
  const d = allowedToolsFor("discord");
  assert.ok(d.includes("Bash(discord-cli *)") && !/Bash\(node \S+ \*\)/.test(d));
  const m = allowedToolsFor("mail");
  assert.ok(m.includes("Bash(mail *)") && !/Bash\(node \S+ \*\)/.test(m), "mail surface mockable via Bash(mail *)");
  assert.throws(() => allowedToolsFor("nope"), /unknown eval surface/);
});

test("buildSlots: all defaults present, paths under cwd, scenario slots win", () => {
  const cwd = "/tmp/evalcwd";
  const slots = buildSlots("discord", { slots: { TRIGGER_AUTHOR: "maya", HISTORY: "hi" } }, cwd);
  assert.equal(slots.TRIGGER_AUTHOR, "maya");       // scenario override
  assert.equal(slots.HISTORY, "hi");
  assert.equal(slots.PERSONA_NAME, "Baxter");        // default kept
  assert.equal(slots.MEMORY_PATH, join(cwd, "memory.md")); // cwd-derived
});

test("renderScenarioPrompt fills EVERY {{SLOT}} in the real discord template (catches a new placeholder)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "evalrender-"));
  const prompt = renderScenarioPrompt("discord",
    { slots: { HISTORY: "erik: hello", TRIGGER_AUTHOR: "erik" } }, cwd);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt), "no unfilled {{SLOT}} remains");
  assert.ok(prompt.includes("erik: hello"));         // HISTORY injected
  assert.ok(prompt.includes(join(cwd, "memory.md"))); // MEMORY_PATH injected
});

test("renderScenarioPrompt fills EVERY {{SLOT}} in the real heartbeat template too", () => {
  const cwd = mkdtempSync(join(tmpdir(), "evalrenderhb-"));
  const prompt = renderScenarioPrompt("heartbeat", { slots: { TASK: "post the HN top story" } }, cwd);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt));
  assert.ok(prompt.includes("post the HN top story"));
});

test("renderScenarioPrompt fills EVERY {{SLOT}} in the real email template too", () => {
  const cwd = mkdtempSync(join(tmpdir(), "evalrendermail-"));
  const prompt = renderScenarioPrompt("mail",
    { slots: { FROM: "erik@example.com", SUBJECT: "hello", BODY: "how are you?", MESSAGE_ID: "<m1@x>" } }, cwd);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt));
  assert.ok(prompt.includes("how are you?"));       // BODY injected
  assert.ok(prompt.includes(join(cwd, "memory.md"))); // MEMORY_PATH injected
});

test("passThreshold: ceil(2/3 * samples) by default", () => {
  assert.equal(passThreshold(3, 3), true);   // 3/3
  assert.equal(passThreshold(2, 3), true);   // 2/3 -> ceil(2)=2, ok
  assert.equal(passThreshold(1, 3), false);  // 1/3
  assert.equal(passThreshold(4, 5), true);   // ceil(3.33)=4
  assert.equal(passThreshold(3, 5), false);
  assert.equal(passThreshold(0, 0), false);  // no samples -> not a pass
});

test("formatTable renders per-scenario PASS/FAIL + an overall line", () => {
  const out = formatTable([
    { name: "a", samples: 3, passes: 3, pass: true },
    { name: "b", samples: 3, passes: 1, pass: false },
  ]);
  assert.ok(out.includes("[PASS] a  (3/3)"));
  assert.ok(out.includes("[FAIL] b  (1/3)"));
  assert.ok(out.includes("1/2 scenarios passed"));
});
