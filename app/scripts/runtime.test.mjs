// Unit tests for runtime.mjs's harness-neutral pieces. Run with `node --test`
// (no dependency -- node:test is built in). Covers the skills staging
// (ensureSkills), the safe template fill (fillTemplate), the reset-time
// formatter (formatResetTime), harness selection (getHarness), and the generic
// runAgent orchestration driven through an INJECTED fake adapter so the seam is
// exercised without ever spawning a real agent binary. The Claude-specific
// stream decoding + usage-limit detection live in harnesses/claude.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatResetTime, fillTemplate, ensureSkills, skillsPreamble, getHarness, runAgent, harnessLabel, redactToolInput } from "./runtime.mjs";
import { BAKED_SKILL_NAMES } from "./grants.mjs";
import { claudeHarness } from "./harnesses/claude.mjs";

test("skillsPreamble lists learned skills by name only, sorted, baked + non-dirs excluded", () => {
  const learned = mkdtempSync(join(tmpdir(), "rtskill-"));
  assert.equal(skillsPreamble(learned), "(none yet)"); // empty
  mkdirSync(join(learned, "data-cli-espn"));
  mkdirSync(join(learned, "acme-bot"));
  mkdirSync(join(learned, [...BAKED_SKILL_NAMES][0])); // a baked name can't stage as learned -> excluded
  writeFileSync(join(learned, "notes.txt"), "x"); // a file, not a skill dir -> excluded
  assert.equal(skillsPreamble(learned), "- acme-bot\n- data-cli-espn");
});

test("skillsPreamble sanitizes an attacker-chosen skill dir name (no newline smuggled into the preamble)", () => {
  const learned = mkdtempSync(join(tmpdir(), "rtskillinj-"));
  mkdirSync(join(learned, "evil\nInjected instruction")); // newline is a legal filename char
  const out = skillsPreamble(learned);
  assert.equal(out.split("\n").length, 1); // one list item -- the newline did NOT become a new preamble line
  assert.equal(out, "- evil Injected instruction");
});

test("skillsPreamble returns (none yet) when the dir is absent", () => {
  assert.equal(skillsPreamble(join(tmpdir(), "rtskill-does-not-exist-" + Date.now())), "(none yet)");
});

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

test("ensureSkills doesn't prune a baked skill from skillSrcs not in the constant", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  const baked = join(root, "src", "mybaked"); // a baked skill name not in BAKED_SKILL_NAMES
  mkdirSync(baked, { recursive: true });
  writeFileSync(join(baked, "SKILL.md"), "# mybaked");
  const cwdSkills = join(root, "cwd-skills");
  ensureSkills([baked], cwdSkills, join(root, "learned-skills"));
  assert.ok(existsSync(join(cwdSkills, "mybaked", "SKILL.md")), "caller-baked skill survives the prune");
});

test("ensureSkills replaces (not overlays) a learned skill so removed files disappear", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  const learned = join(root, "learned-skills");
  const cwdSkills = join(root, "cwd-skills");
  mkdirSync(join(learned, "foo", "references"), { recursive: true });
  writeFileSync(join(learned, "foo", "SKILL.md"), "# foo");
  writeFileSync(join(learned, "foo", "references", "extra.md"), "extra");
  ensureSkills([], cwdSkills, learned); // stages foo including references/extra.md
  assert.ok(existsSync(join(cwdSkills, "foo", "references", "extra.md")));
  rmSync(join(learned, "foo", "references"), { recursive: true, force: true }); // operator removes a file
  ensureSkills([], cwdSkills, learned); // re-stage
  assert.ok(!existsSync(join(cwdSkills, "foo", "references")), "removed file gone from staged copy");
  assert.ok(existsSync(join(cwdSkills, "foo", "SKILL.md")), "skill itself still present");
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

test("formatResetTime returns null for a missing/zero reset time", () => {
  assert.equal(formatResetTime(null), null);
  assert.equal(formatResetTime(0), null);
});

test("formatResetTime renders a Pacific-time string for a real reset time", () => {
  const out = formatResetTime(1_700_000_000);
  assert.equal(typeof out, "string");
  assert.match(out, /(PST|PDT)/);
});

test("getHarness defaults to the claude adapter and rejects an unknown name", () => {
  assert.equal(getHarness(), claudeHarness); // unset BAXTER_HARNESS -> claude
  assert.equal(getHarness(""), claudeHarness); // blank .env / unset compose var arrives as "" -> claude
  assert.equal(getHarness("claude"), claudeHarness);
  assert.throws(() => getHarness("nope"), /Unknown BAXTER_HARNESS "nope"/);
});

// A minimal fake harness whose buildInvocation points at a tiny `node -e` script
// that writes two lines to stdout, so runAgent's spawn/line-buffer/render/return
// path is exercised end-to-end without a real agent binary.
function fakeHarness(inlineScript, { detect } = {}) {
  const seen = {};
  return {
    seen,
    adapter: {
      name: "fake",
      buildInvocation(opts) {
        seen.buildInvocation = opts;
        return { command: process.execPath, args: ["-e", inlineScript] };
      },
      parseEvents: (line) => [{ kind: "text", text: line }],
      detectOutcome: (rawLines) => (detect ? detect(rawLines) : { outOfTokens: false, resetsAt: null }),
    },
  };
}

test("runAgent drives an injected harness: spawns it, captures raw lines, returns the outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "runagent-"));
  const runsDir = join(root, "runs");
  let beforeRan = false;
  const { seen, adapter } = fakeHarness("process.stdout.write('a\\nb\\n')", {
    detect: (lines) => ({ outOfTokens: lines.includes("b"), resetsAt: 42 }),
  });
  const result = await runAgent({
    prompt: "hi",
    logId: "t1",
    cwd: join(root, "cwd"),
    model: "some-model",
    allowedTools: "Read Write",
    runsDir,
    beforeRun: () => (beforeRan = true),
    harness: adapter,
  });
  assert.deepEqual(result, { outOfTokens: true, resetsAt: 42, failed: false });
  assert.equal(beforeRan, true, "beforeRun hook ran");
  assert.deepEqual(seen.buildInvocation, { model: "some-model", allowedTools: "Read Write" });
  const rawLog = readFileSync(join(runsDir, "t1.log"), "utf8");
  assert.match(rawLog, /a\nb/, "raw stdout lines written to the run log");
});

test("runAgent reports failed:true when the harness process exits non-zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "runagent-"));
  const { adapter } = fakeHarness("process.exit(3)");
  const result = await runAgent({
    prompt: "hi",
    logId: "t2",
    cwd: join(root, "cwd"),
    model: "m",
    allowedTools: "x",
    runsDir: join(root, "runs"),
    harness: adapter,
  });
  assert.equal(result.failed, true, "non-zero exit surfaces as failed");
});

test("harnessLabel formats '<harness> (<model>)' via the injected adapter", () => {
  // Inject the adapter (like runAgent) so this is deterministic regardless of the
  // ambient BAXTER_HARNESS, which harnessLabel otherwise binds at import.
  assert.equal(harnessLabel("haiku", claudeHarness), "claude (haiku)");
  assert.equal(harnessLabel(undefined, claudeHarness), "claude (sonnet)");
});

test("redactToolInput: strips the typed VALUE of a browser type/fill, keeps cli/cmd/ref", () => {
  // structured run_cli: type <ref> <value> -> value redacted, ref kept
  assert.deepEqual(
    redactToolInput({ cli: "invisible-cli", args: ["type", "e47", "B@xter2026!"] }),
    { cli: "invisible-cli", args: ["type", "e47", "<redacted>"] },
  );
  // fill too, and the 2-arg form (type <value>, no ref)
  assert.deepEqual(redactToolInput({ cli: "playwright-cli", args: ["fill", "e1", "secret"] }).args, ["fill", "e1", "<redacted>"]);
  assert.deepEqual(redactToolInput({ args: ["type", "hunter2"] }).args, ["type", "<redacted>"]);
  // non-input browser commands + other tools are untouched
  assert.deepEqual(redactToolInput({ cli: "invisible-cli", args: ["click", "e50"] }).args, ["click", "e50"]);
  assert.deepEqual(redactToolInput({ cli: "invisible-cli", args: ["press", "Enter"] }).args, ["press", "Enter"]);
  assert.deepEqual(redactToolInput({ path: "/x/memory.md" }), { path: "/x/memory.md" });
  assert.equal(redactToolInput(null), null);
});

test("redactToolInput: redacts the value in a Claude-Code Bash command string", () => {
  assert.equal(
    redactToolInput({ command: "invisible-cli type e47 B@xter2026!Burgundy" }).command,
    "invisible-cli type e47 <redacted>",
  );
  assert.equal(
    redactToolInput({ command: "playwright-cli fill e1 my secret phrase" }).command,
    "playwright-cli fill e1 <redacted>",
  );
  // a non-type command is untouched
  assert.equal(redactToolInput({ command: "invisible-cli open https://x" }).command, "invisible-cli open https://x");
  // MULTI-LINE: a type-then-press command must still redact the value (end-of-line, not end-of-string)
  assert.equal(
    redactToolInput({ command: "invisible-cli type e47 B@xter2026!\ninvisible-cli press Enter" }).command,
    "invisible-cli type e47 <redacted>\ninvisible-cli press Enter",
  );
  // a spaced value in the no-ref-visible / raw-selector form is FULLY redacted (no first-word leak)
  assert.equal(
    redactToolInput({ command: 'playwright-cli type "my secret phrase"' }).command,
    "playwright-cli type <redacted>",
  );
  // two type commands on separate lines are both redacted (g flag)
  assert.equal(
    redactToolInput({ command: "invisible-cli type e1 user\ninvisible-cli type e2 pass" }).command,
    "invisible-cli type e1 <redacted>\ninvisible-cli type e2 <redacted>",
  );
  // a QUOTED value spanning newlines is redacted through its closing quote (textarea/bio paste)
  assert.equal(
    redactToolInput({ command: 'invisible-cli type e47 "secret line1\nsecret line2"\ninvisible-cli press Enter' }).command,
    "invisible-cli type e47 <redacted>\ninvisible-cli press Enter",
  );
  // bash string-concatenation (apostrophe-in-password idiom) is fully redacted, not just the first quote
  assert.equal(
    redactToolInput({ command: "invisible-cli type e1 'it'\\''s my secret'" }).command,
    "invisible-cli type e1 <redacted>",
  );
  assert.equal(redactToolInput({ command: 'playwright-cli type e2 "x"123' }).command, "playwright-cli type e2 <redacted>");
  // KNOWN RESIDUAL (pinned, not a bug): a concatenation whose 2nd quoted segment spans a
  // newline redacts only through the first newline on this NON-LIVE Bash path (the live
  // structured path has no such gap -- see the redactToolInput comment).
  assert.equal(
    redactToolInput({ command: "invisible-cli type e1 'it'\\''s my\nsecret'" }).command,
    "invisible-cli type e1 <redacted>\nsecret'",
  );
});
