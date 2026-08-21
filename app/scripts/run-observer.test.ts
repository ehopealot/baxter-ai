// Delivery-only RunObserver tests. The observer preserves successful Mail/SMS
// target/text pairs from structured run_cli and Claude Bash event streams;
// Home URL classification remains in feature-discovery.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunObserver } from "./run-observer.ts";
import type { DiscoveryObservation } from "./feature-discovery.ts";
import type { NormalizedEvent } from "./runtime.ts";

const runCliUse = (cli: string, args: string[], stdin?: string): NormalizedEvent =>
  ({ kind: "tool_use", name: "run_cli", input: stdin === undefined ? { cli, args } : { cli, args, stdin } });
const bashUse = (command: string): NormalizedEvent => ({ kind: "tool_use", name: "Bash", input: { command } });
const use = (name: string, input: unknown): NormalizedEvent => ({ kind: "tool_use", name, input });
const okResult = (content: unknown = { ok: true }): NormalizedEvent => ({ kind: "tool_result", isError: false, content });
const errorResult = (content?: unknown): NormalizedEvent => ({ kind: "tool_result", isError: true, content });
const okFalseResult = (): NormalizedEvent => ({ kind: "tool_result", isError: false, content: { ok: false, error: "boom" } });

const EMPTY: DiscoveryObservation = { deliveries: [] };

function observe(...events: NormalizedEvent[]): DiscoveryObservation {
  const observer = new RunObserver();
  for (const event of events) observer.observe(event);
  return observer.summary();
}

test("structured run_cli records successful mail reply and SMS send/send-group deliveries with exact target and text", () => {
  assert.deepEqual(
    observe(runCliUse("mail-cli", ["reply", "thr-1"], "See https://home.bax.bot/calendar."), okResult()),
    { deliveries: [{ target: "thr-1", text: "See https://home.bax.bot/calendar." }] },
  );
  assert.deepEqual(
    observe(runCliUse("sms-cli", ["send", "+15551234567"], "hi there"), okResult()),
    { deliveries: [{ target: "+15551234567", text: "hi there" }] },
  );
  assert.deepEqual(
    observe(runCliUse("sms-cli", ["send-group", "grp_ABC-123"], "hello group"), okResult()),
    { deliveries: [{ target: "grp_ABC-123", text: "hello group" }] },
  );
  assert.deepEqual(
    observe(runCliUse("mail-cli", ["reply", "thr-empty"]), okResult()),
    { deliveries: [{ target: "thr-empty", text: "" }] },
    "absent structured stdin is preserved as empty text",
  );
});

test("structured failed results, malformed payloads, missing targets, and non-delivery verbs record nothing", () => {
  assert.deepEqual(observe(runCliUse("sms-cli", ["send", "+1"], "x"), errorResult()), EMPTY);
  assert.deepEqual(observe(runCliUse("sms-cli", ["send", "+1"], "x"), okFalseResult()), EMPTY);
  assert.deepEqual(observe(runCliUse("sms-cli", ["send"]), okResult()), EMPTY);
  assert.deepEqual(observe(runCliUse("sms-cli", ["send", ""], "x"), okResult()), EMPTY);
  assert.deepEqual(observe(runCliUse("mail-cli", ["send", "a@example.com"], "x"), okResult()), EMPTY);
  assert.deepEqual(observe(runCliUse("sms-cli", ["send-contact", "+1"], "x"), okResult()), EMPTY);
  assert.deepEqual(observe(runCliUse("sms-cli", ["read", "+1"], "x"), okResult()), EMPTY);
  assert.deepEqual(observe(use("run_cli", { cli: "sms-cli", args: "send", stdin: "x" }), okResult()), EMPTY);
  assert.deepEqual(observe(use("run_cli", { cli: "sms-cli", args: ["send", 7], stdin: "x" }), okResult()), EMPTY);
  assert.deepEqual(observe(use("run_cli", { cli: 7, args: ["send", "+1"], stdin: "x" }), okResult()), EMPTY);
  assert.deepEqual(observe(use("run_cli", { cli: "sms-cli", args: ["send", "+1"], stdin: 42 }), okResult()), EMPTY);
  for (const input of [null, "sms-cli", ["sms-cli"]]) {
    assert.deepEqual(observe(use("run_cli", input), okResult()), EMPTY);
  }
});

test("tool results commit only their FIFO-paired uses, including null slots for unrelated tools", () => {
  const paired = observe(
    runCliUse("mail-cli", ["reply", "thr-1"], "mail"),
    runCliUse("sms-cli", ["send", "+15551234567"], "sms"),
    errorResult(),
    okResult(),
  );
  assert.deepEqual(paired, { deliveries: [{ target: "+15551234567", text: "sms" }] });

  const unrelatedSlot = observe(
    use("WebSearch", { query: "x" }),
    runCliUse("mail-cli", ["reply", "thr-2"], "body"),
    okResult(),
    okResult(),
  );
  assert.deepEqual(unrelatedSlot, { deliveries: [{ target: "thr-2", text: "body" }] });
});

test("unmatched results and uses whose result never arrives record nothing", () => {
  assert.deepEqual(observe(okResult()), EMPTY);
  assert.deepEqual(observe(runCliUse("mail-cli", ["reply", "thr-1"], "body")), EMPTY);
  assert.deepEqual(
    observe(errorResult(), runCliUse("mail-cli", ["reply", "thr-1"], "body"), okResult()),
    { deliveries: [{ target: "thr-1", text: "body" }] },
  );
});

test("Claude Bash records direct heredoc deliveries for both surfaces and the absolute node form", () => {
  assert.deepEqual(
    observe(bashUse(`mail-cli reply thr-1 <<'EOF'
See https://home.bax.bot/calendar.
EOF`), okResult()),
    { deliveries: [{ target: "thr-1", text: "See https://home.bax.bot/calendar." }] },
  );
  assert.deepEqual(
    observe(bashUse(`sms-cli send +15551234567 <<'EOF'
hi
EOF`), okResult()),
    { deliveries: [{ target: "+15551234567", text: "hi" }] },
  );
  assert.deepEqual(
    observe(bashUse(`node /app/scripts/sms-cli.ts send-group grp-9 <<'EOF'
hello
EOF`), okResult()),
    { deliveries: [{ target: "grp-9", text: "hello" }] },
  );
});

test("Claude Bash records printf/echo producer text piped to delivery commands", () => {
  assert.deepEqual(
    observe(bashUse("printf 'See https://home.bax.bot/calendar.' | sms-cli send +15551234567"), okResult()),
    { deliveries: [{ target: "+15551234567", text: "See https://home.bax.bot/calendar." }] },
  );
  assert.deepEqual(
    observe(bashUse("echo Calendar is up | mail-cli reply thr-2"), okResult()),
    { deliveries: [{ target: "thr-2", text: "Calendar is up" }] },
  );
});

test("Claude success uses isError only, while failed Bash results record nothing", () => {
  const command = `mail-cli reply thr-1 <<'EOF'
body
EOF`;
  assert.deepEqual(observe(bashUse(command), okResult({ ok: false })), { deliveries: [{ target: "thr-1", text: "body" }] });
  assert.deepEqual(observe(bashUse(command), errorResult({ ok: true })), EMPTY);
});

test("malformed and rejected Claude Bash shapes fail open without throwing", () => {
  for (const input of [null, ["command"], {}, { command: 1 }]) {
    assert.doesNotThrow(() => assert.deepEqual(observe(use("Bash", input), okResult()), EMPTY));
  }
  for (const command of [
    "mail-cli reply thr-1",
    "node mail-cli.ts reply thr-1",
    `node /tmp/mail-cli.js reply thr-1 <<'EOF'\nx\nEOF`,
    `node /app/scripts/mail-cli-evil.ts reply thr-1 <<'EOF'\nx\nEOF`,
    "mail-cli reply thr-1 > out",
    "printf hi | calendar-cli list",
    "calendar-cli list | sms-cli send +15551234567",
    `printf x | sms-cli send +15551234567 <<EOF\nb\nEOF`,
    "printf a | tr a-z A-Z | mail-cli reply thr-1",
  ]) {
    assert.deepEqual(observe(bashUse(command), okResult()), EMPTY, command);
  }
});

test("feature CLIs and unrelated tools remain unobserved, and deliveries retain stream order without deduplication", () => {
  for (const event of [
    runCliUse("collections-cli", ["save", "trip"], "body"),
    runCliUse("calendar-cli", ["list"]),
    bashUse("schedule-cli list"),
    use("load_skill", { name: "calendar" }),
    use("WebSearch", { query: "x" }),
  ]) {
    assert.deepEqual(observe(event, okResult()), EMPTY);
  }
  const summary = observe(
    runCliUse("mail-cli", ["reply", "thr-1"], "same"), okResult(),
    runCliUse("mail-cli", ["reply", "thr-1"], "same"), okResult(),
    runCliUse("sms-cli", ["send-group", "grp-9"], "last"), okResult(),
  );
  assert.deepEqual(summary.deliveries, [
    { target: "thr-1", text: "same" },
    { target: "thr-1", text: "same" },
    { target: "grp-9", text: "last" },
  ]);
});
