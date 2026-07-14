// Unit tests for runtime.mjs's pure detection helpers. Run with `node --test`
// (no dependency -- node:test is built in). These cover detectOutOfTokens's
// stream-json scanning and the success-gating that suppresses a false notice
// after a run that actually replied; the comment on detectOutOfTokens asks a
// future maintainer to tune the status deny-list on the first real occurrence,
// so this is the regression check for that edit. Imports the real functions
// from runtime.mjs, not a hand-copied reimplementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectOutOfTokens, formatResetTime, fillTemplate, ensureSkills } from "./runtime.mjs";

test("ensureSkills stages the agent's learned skills into the cwd skills dir", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  const learned = join(root, "learned-skills");
  const cwdSkills = join(root, "cwd-skills");
  mkdirSync(join(learned, "reminderbot"), { recursive: true });
  writeFileSync(join(learned, "reminderbot", "SKILL.md"), "# reminderbot skill");
  ensureSkills([], cwdSkills, learned); // no baked srcs; just stage learned
  assert.ok(existsSync(join(cwdSkills, "reminderbot", "SKILL.md")), "learned skill copied into .claude/skills");
});

test("ensureSkills tolerates a missing learned-skills dir (creates it)", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  const learned = join(root, "learned-skills"); // does not exist yet
  ensureSkills([], join(root, "cwd-skills"), learned);
  assert.ok(existsSync(learned), "learned-skills dir created for the agent to write into");
});

test("ensureSkills refuses to stage a learned skill that shadows a baked one", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  const learned = join(root, "learned-skills");
  const cwdSkills = join(root, "cwd-skills");
  mkdirSync(join(learned, "discord"), { recursive: true }); // reserved baked name
  writeFileSync(join(learned, "discord", "SKILL.md"), "# poisoned override");
  ensureSkills([], cwdSkills, learned);
  assert.ok(!existsSync(join(cwdSkills, "discord")), "reserved-name learned skill not staged");
});

test("ensureSkills prunes a staged skill no longer present in learned-skills", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  const learned = join(root, "learned-skills");
  const cwdSkills = join(root, "cwd-skills");
  mkdirSync(join(cwdSkills, "oldbot"), { recursive: true }); // stale staged skill from a prior run
  writeFileSync(join(cwdSkills, "oldbot", "SKILL.md"), "# stale");
  mkdirSync(learned, { recursive: true }); // learned-skills no longer has oldbot
  ensureSkills([], cwdSkills, learned);
  assert.ok(!existsSync(join(cwdSkills, "oldbot")), "stale staged skill pruned");
});

test("fillTemplate inserts values verbatim -- no $-expansion, no placeholder re-scan", () => {
  // X's value contains a $-sequence and a {{Y}}: both must survive verbatim
  // (single pass), while the template's own {{Y}} gets filled.
  const out = fillTemplate("a {{X}} b {{Y}} c", { X: "$' & {{Y}}", Y: "REAL" });
  assert.equal(out, "a $' & {{Y}} b REAL c");
});

test("fillTemplate leaves unknown placeholders intact", () => {
  assert.equal(fillTemplate("{{X}} {{UNKNOWN}}", { X: "v" }), "v {{UNKNOWN}}");
});

const j = (obj) => JSON.stringify(obj);

test("healthy run that replied is not flagged", () => {
  const lines = [
    j({ type: "system", subtype: "init", model: "claude-sonnet-5" }),
    j({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1_700_000_000 } }),
    j({ type: "result", is_error: false, result: "Done." }),
  ];
  assert.deepEqual(detectOutOfTokens(lines), { outOfTokens: false, resetsAt: 1_700_000_000 });
});

test("allowed_warning is still a healthy status", () => {
  const lines = [
    j({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 42 } }),
    j({ type: "result", is_error: false, result: "ok" }),
  ];
  assert.equal(detectOutOfTokens(lines).outOfTokens, false);
});

test("blocking rate_limit status on a failed run flags out-of-tokens with reset time", () => {
  const lines = [
    j({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_700_000_999 } }),
    j({ type: "result", is_error: true, result: "stopped" }),
  ];
  assert.deepEqual(detectOutOfTokens(lines), { outOfTokens: true, resetsAt: 1_700_000_999 });
});

test("bare 429 terminal result flags out-of-tokens", () => {
  const lines = [j({ type: "result", is_error: true, api_error_status: 429, result: "" })];
  assert.equal(detectOutOfTokens(lines).outOfTokens, true);
});

test("usage-limit text in a failed result flags out-of-tokens", () => {
  const lines = [j({ type: "result", is_error: true, result: "Claude AI usage limit reached" })];
  assert.equal(detectOutOfTokens(lines).outOfTokens, true);
});

test("success suppresses a stray blocking status (no false notice after a real reply)", () => {
  // A run that did its work and replied, but the stream also carried a
  // non-allowed status -- the run still ended in a successful terminal result,
  // so no out-of-tokens notice should fire.
  const lines = [
    j({ type: "rate_limit_event", rate_limit_info: { status: "some_new_status", resetsAt: 5 } }),
    j({ type: "assistant", message: { content: [{ type: "text", text: "replied" }] } }),
    j({ type: "result", is_error: false, result: "sent the reply" }),
  ];
  assert.equal(detectOutOfTokens(lines).outOfTokens, false);
});

test("non-JSON lines are skipped without throwing", () => {
  const lines = [
    "claude: some non-JSON failure line",
    "",
    j({ type: "result", is_error: true, api_error_status: 429 }),
  ];
  assert.equal(detectOutOfTokens(lines).outOfTokens, true);
});

test("no rate-limit and no result leaves both fields at defaults", () => {
  const lines = [j({ type: "system", subtype: "init" })];
  assert.deepEqual(detectOutOfTokens(lines), { outOfTokens: false, resetsAt: null });
});

test("formatResetTime returns null for a missing/zero reset time", () => {
  assert.equal(formatResetTime(null), null);
  assert.equal(formatResetTime(0), null);
});

test("formatResetTime renders a Pacific-time string for a real reset time", () => {
  const out = formatResetTime(1_700_000_000);
  assert.equal(typeof out, "string");
  assert.match(out, /(PST|PDT)/);
});
