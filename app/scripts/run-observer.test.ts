// Tests for run-observer (spec: docs/superpowers/specs/2026-08-19-cross-
// surface-home-link-discovery-design.md §4/§5; plan task T6): the PASSIVE
// per-run observer fed to runAgent as onEvent. It records successful feature
// interactions and successful outbound deliveries ({target, text}) for BOTH
// invocation families -- the structured run_cli family ({cli,args,stdin?})
// and the opt-in Claude Bash family ({command}) -- with payload SHAPE
// VALIDATION in front of both (a malformed payload records nothing and never
// throws; the Bash guard runs BEFORE tokenizeCommand), FIFO tool_use/
// tool_result pairing (tool_result events carry no tool name on any harness,
// so each result commits only its stream-paired use), and the node-form path
// constraint (absolute path, final segment '.ts', exact-basename equality).
// It is classification of already-executed allowlisted tool events, never an
// authorization boundary: deliveries carry RAW text only -- all route/link
// matching happens later in feature-discovery's deliveredLinkFeatures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunObserver } from "./run-observer.ts";
import { FEATURE_KEYS } from "./intro-state.ts";
import type { DiscoveryObservation } from "./feature-discovery.ts";
import type { NormalizedEvent } from "./runtime.ts";

// Hand-built NormalizedEvent sequences -- no harness needed.
const runCliUse = (cli: string, args: string[], stdin?: string): NormalizedEvent =>
  ({ kind: "tool_use", name: "run_cli", input: stdin === undefined ? { cli, args } : { cli, args, stdin } });
const bashUse = (command: string): NormalizedEvent => ({ kind: "tool_use", name: "Bash", input: { command } });
const use = (name: string, input: unknown): NormalizedEvent => ({ kind: "tool_use", name, input });
const okResult = (content: unknown = { ok: true }): NormalizedEvent => ({ kind: "tool_result", isError: false, content });
const isErrResult = (content?: unknown): NormalizedEvent => ({ kind: "tool_result", isError: true, content });
// A structured ToolResult payload reporting failure without isError set.
const okFalseResult = (): NormalizedEvent => ({ kind: "tool_result", isError: false, content: { ok: false, error: "boom" } });

const EMPTY: DiscoveryObservation = { interactions: [], deliveries: [] };

function observe(...events: NormalizedEvent[]): DiscoveryObservation {
  const o = new RunObserver();
  for (const ev of events) o.observe(ev);
  return o.summary();
}

// ---------------------------------------------------------------------------
// Structured run_cli family
// ---------------------------------------------------------------------------

test("structured run_cli recognizes every catalog CLI on a successful paired result (read and write verbs)", () => {
  assert.deepEqual(observe(runCliUse("calendar-cli", ["list"]), okResult()).interactions, ["calendar"]);
  assert.deepEqual(observe(runCliUse("checklist-cli", ["make", "Groceries"]), okResult()).interactions, ["checklists"]);
  assert.deepEqual(observe(runCliUse("recipes-cli", ["show", "weeknight-pasta"]), okResult()).interactions, ["recipes"]);
  assert.deepEqual(observe(runCliUse("collections-cli", ["save", "trip"], "body"), okResult()).interactions, ["collections"]);
  assert.deepEqual(observe(runCliUse("schedule-cli", ["add", "do a thing"]), okResult()).interactions, ["scheduled"]);
});

test("schedule-cli is narrowed to add/list/cancel; 'groups' and anything else never qualifies", () => {
  assert.deepEqual(observe(runCliUse("schedule-cli", ["groups"]), okResult()).interactions, []);
  assert.deepEqual(observe(runCliUse("schedule-cli", ["nonsense"]), okResult()).interactions, []);
  for (const verb of ["add", "list", "cancel"]) {
    assert.deepEqual(observe(runCliUse("schedule-cli", [verb]), okResult()).interactions, ["scheduled"]);
  }
});

test("a failed paired result records nothing: isError true, or structured content ok:false", () => {
  assert.deepEqual(observe(runCliUse("calendar-cli", ["list"]), isErrResult({ ok: false })).interactions, []);
  assert.deepEqual(observe(runCliUse("calendar-cli", ["list"]), okFalseResult()).interactions, []);
  const sms = observe(runCliUse("sms-cli", ["send", "+15551234567"], "hi"), okFalseResult());
  assert.deepEqual(sms.deliveries, []);
});

test("structured deliveries record {target, text} with the stdin body; mail 'send' and sms send-contact/read never count", () => {
  const mail = observe(runCliUse("mail-cli", ["reply", "thr-1"], "See https://home.bax.bot/calendar."), okResult());
  assert.deepEqual(mail.deliveries, [{ target: "thr-1", text: "See https://home.bax.bot/calendar." }]);
  const send = observe(runCliUse("sms-cli", ["send", "+15551234567"], "hi there"), okResult());
  assert.deepEqual(send.deliveries, [{ target: "+15551234567", text: "hi there" }]);
  const group = observe(runCliUse("sms-cli", ["send-group", "grp-9"], "hello group"), okResult());
  assert.deepEqual(group.deliveries, [{ target: "grp-9", text: "hello group" }]);
  // Absent stdin is still a delivery with '' text (matching happens later).
  assert.deepEqual(observe(runCliUse("mail-cli", ["reply", "thr-2"]), okResult()).deliveries, [{ target: "thr-2", text: "" }]);
  // Non-qualifying delivery verbs record nothing at all (no interaction either).
  assert.deepEqual(observe(runCliUse("mail-cli", ["send", "a@b.c"], "x"), okResult()), EMPTY);
  assert.deepEqual(observe(runCliUse("sms-cli", ["send-contact", "+15551234567"], "x"), okResult()), EMPTY);
  assert.deepEqual(observe(runCliUse("sms-cli", ["read", "+15551234567"], "x"), okResult()), EMPTY);
});

test("structured shape guards: any violation records nothing", () => {
  // {cli:'sms-cli', args:['send']} -- a delivery shape with NO target: must
  // never record a 'undefined'/'' target.
  assert.deepEqual(observe(runCliUse("sms-cli", ["send"]), okResult()), EMPTY);
  // Non-array args / non-string arg elements / non-string cli.
  assert.deepEqual(observe(use("run_cli", { cli: "calendar-cli", args: "list" }), okResult()), EMPTY);
  assert.deepEqual(observe(use("run_cli", { cli: "calendar-cli", args: ["list", 3] }), okResult()), EMPTY);
  assert.deepEqual(observe(use("run_cli", { cli: 7, args: ["list"] }), okResult()), EMPTY);
  // Non-string stdin (both a delivery and a bare interaction).
  assert.deepEqual(observe(use("run_cli", { cli: "sms-cli", args: ["send", "+15551234567"], stdin: 42 }), okResult()), EMPTY);
  assert.deepEqual(observe(use("run_cli", { cli: "calendar-cli", args: ["list"], stdin: 1 }), okResult()), EMPTY);
  // Non-object input: a string, null, an array.
  assert.deepEqual(observe(use("run_cli", "calendar-cli"), okResult()), EMPTY);
  assert.deepEqual(observe(use("run_cli", null), okResult()), EMPTY);
  assert.deepEqual(observe(use("run_cli", ["calendar-cli"]), okResult()), EMPTY);
});

// ---------------------------------------------------------------------------
// FIFO pairing (tool_result events carry no tool name on any harness)
// ---------------------------------------------------------------------------

test("each tool_result commits ONLY its FIFO-paired tool_use (concrete two-pair regression)", () => {
  const a = observe(
    runCliUse("calendar-cli", ["list"]),
    runCliUse("recipes-cli", ["list"]),
    okResult(), // pairs calendar-cli
    isErrResult(), // pairs recipes-cli
  );
  assert.deepEqual(a.interactions, ["calendar"], "the failed pair's key never leaks and the successful one is never dropped");
  const b = observe(
    runCliUse("calendar-cli", ["list"]),
    runCliUse("recipes-cli", ["list"]),
    isErrResult(), // pairs calendar-cli
    okResult(), // pairs recipes-cli
  );
  assert.deepEqual(b.interactions, ["recipes"]);
  // An unrelated tool_use still occupies its FIFO slot (the runtime.ts metering
  // precedent), so results stay stream-aligned with their uses.
  const c = observe(
    runCliUse("calendar-cli", ["list"]),
    use("WebSearch", { query: "x" }),
    okResult(), // pairs WebSearch -- records nothing
    okResult(), // pairs calendar-cli
  );
  assert.deepEqual(c.interactions, ["calendar"]);
});

test("unmatched results and never-completed uses record nothing", () => {
  assert.deepEqual(observe(okResult()), EMPTY);
  // A result with no pending use is dropped; the following pair still commits.
  assert.deepEqual(observe(isErrResult(), runCliUse("calendar-cli", ["list"]), okResult()).interactions, ["calendar"]);
  assert.deepEqual(observe(runCliUse("calendar-cli", ["list"])).interactions, [], "a use whose result never arrives records nothing");
});

// ---------------------------------------------------------------------------
// Claude Bash family: payload guard and node-form path constraint
// ---------------------------------------------------------------------------

test("malformed Bash payloads record nothing and never throw (the shape guard runs BEFORE tokenizeCommand)", () => {
  for (const input of [null, ["command"], {}, { command: 1 }]) {
    assert.doesNotThrow(() => {
      const s = observe(use("Bash", input), okResult());
      assert.deepEqual(s, EMPTY, `input ${JSON.stringify(input)} records nothing`);
    });
  }
});

test("the Bash node form resolves ONLY from an absolute path whose final segment ends '.ts'", () => {
  const direct = observe(
    bashUse(`node /app/scripts/mail-cli.ts reply abc-123 <<'EOF'
Hello from node.
EOF`),
    okResult(),
  );
  assert.deepEqual(direct.deliveries, [{ target: "abc-123", text: "Hello from node." }]);
  assert.deepEqual(
    observe(bashUse(`node /tmp/mail-cli.js reply abc-123 <<'EOF'
x
EOF`), okResult()),
    EMPTY,
    "wrong extension (.js) resolves to no CLI",
  );
  assert.deepEqual(observe(bashUse("node calendar-cli.ts list"), okResult()), EMPTY, "relative path resolves to no CLI");
  assert.deepEqual(observe(bashUse("node /app/scripts/calendar-cli-evil.ts list"), okResult()), EMPTY, "wrong basename resolves to no CLI");
  // The verb rule keys on the CLI's own first argument (AFTER the script
  // path), not on the script path itself.
  assert.deepEqual(observe(bashUse("node /app/scripts/schedule-cli.ts groups"), okResult()), EMPTY);
  assert.deepEqual(observe(bashUse("node /app/scripts/schedule-cli.ts list"), okResult()).interactions, ["scheduled"]);
});

// ---------------------------------------------------------------------------
// Claude Bash family: accepted shapes
// ---------------------------------------------------------------------------

test("Claude Bash accepts a direct feature call, quoted args, the node form, and a save heredoc with an opaque body", () => {
  assert.deepEqual(observe(bashUse("calendar-cli list"), okResult()).interactions, ["calendar"]);
  assert.deepEqual(observe(bashUse("checklist-cli find 'groceries bought'"), okResult()).interactions, ["checklists"]);
  assert.deepEqual(observe(bashUse("node /app/scripts/calendar-cli.ts list"), okResult()).interactions, ["calendar"]);
  const save = observe(
    bashUse(`collections-cli save trip <<'EOF'
Plan; see $(not a command) and ` + "`calendar-cli`" + ` notes.
EOF`),
    okResult(),
  );
  assert.deepEqual(save.interactions, ["collections"], "<<'EOF' bodies are opaque: ';', '$(' and backticks in the body never disqualify");
  // The schedule-cli verb rule applies in the Bash family too.
  assert.deepEqual(observe(bashUse("schedule-cli groups"), okResult()).interactions, []);
  assert.deepEqual(observe(bashUse("schedule-cli list"), okResult()).interactions, ["scheduled"]);
});

test("Claude Bash accepts direct delivery commands with heredoc bodies (both surfaces, plain and node form)", () => {
  const mail = observe(bashUse(`mail-cli reply thr-1 <<'EOF'
See https://home.bax.bot/calendar.
EOF`), okResult());
  assert.deepEqual(mail.deliveries, [{ target: "thr-1", text: "See https://home.bax.bot/calendar." }]);
  const sms = observe(bashUse(`sms-cli send +15551234567 <<'EOF'
hi
EOF`), okResult());
  assert.deepEqual(sms.deliveries, [{ target: "+15551234567", text: "hi" }]);
  const grp = observe(bashUse(`sms-cli send-group grp-9 <<'EOF'
hello group
EOF`), okResult());
  assert.deepEqual(grp.deliveries, [{ target: "grp-9", text: "hello group" }]);
  const nodeForm = observe(bashUse(`node /app/scripts/sms-cli.ts send-group grp-9 <<'EOF'
hello
EOF`), okResult());
  assert.deepEqual(nodeForm.deliveries, [{ target: "grp-9", text: "hello" }]);
  // Missing heredoc -> NOT a recognized delivery (fail open).
  assert.deepEqual(observe(bashUse("mail-cli reply thr-1"), okResult()), EMPTY);
});

test("a Bash result whose raw content is {ok:false} still succeeded (ok:false is the structured family's failure signal only)", () => {
  // Claude result content is arbitrary raw content passed through as unknown
  // (harnesses/claude.ts), so only isError marks Bash failure. Regression: the
  // content.ok === false check was once applied to every family, wrongly
  // dropping successful Bash interactions/deliveries whose content happened
  // to be {ok:false} (spec §4: ok !== false applies to structured results).
  const interaction = observe(bashUse("calendar-cli list"), okResult({ ok: false }));
  assert.deepEqual(interaction.interactions, ["calendar"]);
  const delivery = observe(
    bashUse(`mail-cli reply thr-1 <<'EOF'
See https://home.bax.bot/calendar.
EOF`),
    okResult({ ok: false }),
  );
  assert.deepEqual(delivery.deliveries, [{ target: "thr-1", text: "See https://home.bax.bot/calendar." }]);
});

test("a printf/echo body-producer piped into a delivery command records the producer's literal text", () => {
  const p = observe(bashUse("printf 'See https://home.bax.bot/calendar.' | sms-cli send +15551234567"), okResult());
  assert.deepEqual(p.deliveries, [{ target: "+15551234567", text: "See https://home.bax.bot/calendar." }]);
  const e = observe(bashUse("echo Calendar is up | mail-cli reply thr-2"), okResult());
  assert.deepEqual(e.deliveries, [{ target: "thr-2", text: "Calendar is up" }]);
});

// ---------------------------------------------------------------------------
// Claude Bash family: every rejected shape fails open
// ---------------------------------------------------------------------------

test("every tokenizer-rejected Bash form fails open (empty summary)", () => {
  for (const command of [
    "calendar-cli list\nnext-command", // a second command after a newline
    "calendar-cli list &", // background
    "calendar-cli list > out", // redirects
    "calendar-cli list < in",
    "calendar-cli list >> app",
    'calendar-cli list "$(cmd)"', // substitution inside double quotes
    `sms-cli send +15551234567 <<EOF
hi $(x)
EOF`, // substitution in an unquoted-delimiter heredoc body
    "calendar-cli list; recipes-cli list", // chained
    "calendar-cli list && recipes-cli list", // compound
    "calendar-cli list $(x)", // substitution in an executing position
    "calendar-cli list `x`",
    "calendar-cli list # a comment",
    "calendar-cli list 'unterminated", // malformed quoting
    "printf a | tr a-z A-Z | mail-cli reply thr-1", // a second pipe stage
  ]) {
    assert.deepEqual(observe(bashUse(command), okResult()), EMPTY, `expected fail-open for ${JSON.stringify(command)}`);
  }
});

test("pipe shapes: non-producer left side, non-delivery right side, or a feature CLI on the right record nothing", () => {
  assert.deepEqual(observe(bashUse("printf hi | calendar-cli list"), okResult()), EMPTY, "a pipe whose right side is a feature CLI records nothing");
  assert.deepEqual(observe(bashUse("printf hi | sms-cli read"), okResult()), EMPTY, "non-delivery right side");
  assert.deepEqual(observe(bashUse("calendar-cli list | sms-cli send +15551234567"), okResult()), EMPTY, "non-producer left side");
  // A piped right side carrying a heredoc is not an accepted shape either: in
  // a real shell the heredoc would REPLACE the piped stdin, so the reply text
  // is not the producer's -- fail open rather than misattribute.
  assert.deepEqual(
    observe(bashUse(`printf x | sms-cli send +15551234567 <<EOF
b
EOF`), okResult()),
    EMPTY,
  );
});

test("prefix confusion never counts: evil executables and argument-position mentions", () => {
  assert.deepEqual(observe(bashUse("calendar-cli-evil list"), okResult()), EMPTY);
  assert.deepEqual(observe(bashUse("notes-cli calendar-cli list"), okResult()), EMPTY, "a feature CLI named only in argument position");
});

// ---------------------------------------------------------------------------
// Unrelated tools; duplicates; summary shape
// ---------------------------------------------------------------------------

test("unrelated tools record nothing (both families: link-cli, files-cli, load_skill, Skill, WebSearch)", () => {
  assert.deepEqual(observe(runCliUse("link-cli", ["list", "x"]), okResult()), EMPTY);
  assert.deepEqual(observe(runCliUse("files-cli", ["list"]), okResult()), EMPTY);
  assert.deepEqual(observe(bashUse("link-cli list x"), okResult()), EMPTY);
  assert.deepEqual(observe(use("load_skill", { name: "calendar" }), okResult()), EMPTY);
  assert.deepEqual(observe(use("Skill", { name: "links" }), okResult()), EMPTY);
  assert.deepEqual(observe(use("WebSearch", { query: "x" }), okResult()), EMPTY);
});

test("duplicate feature interactions collapse to one key; interactions come back in FEATURE_KEYS order", () => {
  const s = observe(
    runCliUse("recipes-cli", ["list"]),
    okResult(),
    bashUse("recipes-cli list"),
    okResult(),
    runCliUse("calendar-cli", ["list"]),
    okResult(),
  );
  assert.deepEqual(s.interactions, ["calendar", "recipes"], "deduped, canonical FEATURE_KEYS order");
  assert.ok(FEATURE_KEYS.indexOf("calendar") < FEATURE_KEYS.indexOf("recipes"), "fixture relies on catalog order");
});

test("deliveries are recorded in stream order (no dedup) and expose raw text only", () => {
  const s = observe(
    runCliUse("mail-cli", ["reply", "thr-1"], "body one"),
    okResult(),
    bashUse(`sms-cli send-group grp-9 <<'EOF'
See https://home.bax.bot/calendar.
EOF`),
    okResult(),
  );
  assert.deepEqual(s.deliveries, [
    { target: "thr-1", text: "body one" },
    { target: "grp-9", text: "See https://home.bax.bot/calendar." },
  ]);
});
