// Offline unit tests for the harness's PURE pieces (no LLM, no runAgent). The
// end-to-end runScenario/runSuite are covered by the live smoke (run.ts, gated on
// an API key), since they call a real model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MOCK_CLIS, doctorTools, allowedToolsFor, buildSlots, renderScenarioPrompt, passThreshold, formatTable, stageScenarioSkills,
} from "./harness.ts";

test("doctorTools converts absolute `node <path>` grants to PATH-friendly ones + dedups", () => {
  const out = doctorTools("Bash(node /app/scripts/mail-cli.ts *) Bash(node /app/scripts/discord-cli.ts *) Bash(discord-cli *) Bash(code-cli *) WebSearch Read");
  assert.ok(!/node /.test(out), "no absolute node-path grant survives");
  assert.ok(out.includes("Bash(mail-cli *)"), "mail-cli node-grant -> friendly Bash(mail-cli *)");
  // discord-cli appeared as BOTH a node-path and a friendly grant -> exactly one now
  assert.equal((out.match(/Bash\(discord-cli \*\)/g) || []).length, 1, "deduped");
  assert.ok(out.includes("Bash(code-cli *)") && out.includes("Read")); // Bash groups + bare tokens survive
});

test("the hermetic mockbin includes every primary CLI used by proactive creation", () => {
  assert.ok(MOCK_CLIS.includes("checklist-cli"), "creation scenario cannot resolve the host checklist-cli");
  assert.ok(MOCK_CLIS.includes("followup-cli"));
});

test("sequential supported to unsupported eval staging prunes proactive-follow-up", () => {
  const cwd = mkdtempSync(join(tmpdir(), "eval-sticky-skills-"));
  try {
    const learned = join(cwd, "learned-skills"); mkdirSync(learned, { recursive: true });
    stageScenarioSkills("mail", cwd, learned);
    assert.equal(existsSync(join(cwd, ".claude", "skills", "proactive-follow-up")), true);
    stageScenarioSkills("discord", cwd, learned);
    assert.equal(existsSync(join(cwd, ".claude", "skills", "proactive-follow-up")), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("allowedToolsFor: PATH-friendly grants per surface, no absolute node grant, unknown throws", () => {
  const d = allowedToolsFor("discord");
  assert.ok(d.includes("Bash(discord-cli *)") && !/Bash\(node \S+ \*\)/.test(d));
  const m = allowedToolsFor("mail");
  assert.ok(m.includes("Bash(mail-cli *)") && !/Bash\(node \S+ \*\)/.test(m), "mail surface mockable via Bash(mail-cli *)");
  for (const surface of ["mail", "sms", "chat"]) assert.ok(allowedToolsFor(surface).includes("Bash(followup-cli *)"));
  for (const surface of ["discord", "heartbeat"]) assert.ok(!allowedToolsFor(surface).includes("followup-cli"));
  assert.ok(allowedToolsFor("sms").includes("Bash(sms-cli *)"));
  assert.ok(allowedToolsFor("chat").includes("Bash(chat-cli *)"));
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

test("renderScenarioPrompt fills EVERY {{SLOT}} in the real discord template (catches a new placeholder)", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "evalrender-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const prompt = renderScenarioPrompt("discord",
    { slots: { HISTORY: "erik: hello", TRIGGER_AUTHOR: "erik" } }, cwd);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt), "no unfilled {{SLOT}} remains");
  assert.ok(prompt.includes("erik: hello"));         // HISTORY injected
  assert.ok(prompt.includes(join(cwd, "memory.md"))); // MEMORY_PATH injected
});

test("renderScenarioPrompt fills EVERY {{SLOT}} in the real heartbeat template too", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "evalrenderhb-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const prompt = renderScenarioPrompt("heartbeat", { slots: { TASK: "post the HN top story" } }, cwd);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt));
  assert.ok(prompt.includes("post the HN top story"));
});

test("renderScenarioPrompt fills EVERY {{SLOT}} in the real SMS and Home Chat templates", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "evalrendersupported-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const sms = renderScenarioPrompt("sms", { slots: { HISTORY: "The person: store on Friday" } }, cwd);
  const chat = renderScenarioPrompt("chat", { slots: { HISTORY: "Erik: store on Friday" } }, cwd);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(sms));
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(chat));
  assert.ok(sms.includes("store on Friday") && chat.includes("store on Friday"));
});

test("renderScenarioPrompt fills EVERY {{SLOT}} in the real email template too", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "evalrendermail-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
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
