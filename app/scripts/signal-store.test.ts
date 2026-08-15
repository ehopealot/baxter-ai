// Task 1 (usage metrics): the per-tenant usage-signal store -- one best-effort
// JSONL append per event into $STATE_DIR/usage/signals.jsonl. Mirrors
// usage-store.test.ts's style: static import + USAGE_DIR_OVERRIDE set at module
// top before any test body (the store reads the override at CALL time, not
// import time). Pins the store-owned versioning BOTH ways: compile-time
// (@ts-expect-error -- a caller-supplied `v` is a type error, and an unused
// directive fails tsc) and runtime (a v:999 smuggled through `unknown` persists
// as v:1, because recordSignal spreads the input FIRST and stamps v LAST).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSignal } from "./signal-store.ts";

const DIR = mkdtempSync(join(tmpdir(), "signals-"));
process.env.USAGE_DIR_OVERRIDE = DIR;

const SIGNALS = join(DIR, "signals.jsonl");

// A parsed JSONL line. Flat (all label fields optional) rather than the module's
// discriminated union: JSON.parse gives no discriminated narrowing, and the
// assertions check exactly the fields each kind carries.
type ParsedEvent = {
  v?: number;
  t: number;
  kind: string;
  surface?: string;
  tool?: string;
  ok?: boolean;
  counterpart?: string;
};

function rows(): ParsedEvent[] {
  return readFileSync(SIGNALS, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ParsedEvent);
}

// Distinct caller-supplied t values so each assertion finds exactly its own line
// regardless of the other tests' writes into the same shared file.
const T = {
  tool: 1755172800000,
  smsRx: 1755172800001,
  smsTx: 1755172800002,
  mailRx: 1755172800003,
  mailTx: 1755172800004,
  clampedTool: 1755172800005,
  clampedSms: 1755172800006,
  tsErr: 1755172800007,
  smuggled: 1755172800008,
  enotdir: 1755172800009,
};

test("each of the five kinds round-trips as a parseable v:1 line carrying the caller's t verbatim", () => {
  recordSignal({ t: T.tool, kind: "tool", surface: "mail", tool: "bash", ok: true });
  recordSignal({ t: T.smsRx, kind: "sms_rx", counterpart: "+15551234567" });
  recordSignal({ t: T.smsTx, kind: "sms_tx", counterpart: "group:12345" });
  recordSignal({ t: T.mailRx, kind: "mail_rx", counterpart: "alice@example.com" });
  recordSignal({ t: T.mailTx, kind: "mail_tx", counterpart: "alice@example.com" });

  const all = rows();
  assert.equal(all.length, 5, "five lines so far, one per recordSignal call");

  const byT = new Map(all.map((r) => [r.t, r]));
  const tool = byT.get(T.tool);
  assert.ok(tool, "tool line present");
  assert.equal(tool.v, 1);
  assert.equal(tool.kind, "tool");
  assert.equal(tool.surface, "mail");
  assert.equal(tool.tool, "bash");
  assert.equal(tool.ok, true);

  for (const [t, kind, counterpart] of [
    [T.smsRx, "sms_rx", "+15551234567"],
    [T.smsTx, "sms_tx", "group:12345"],
    [T.mailRx, "mail_rx", "alice@example.com"],
    [T.mailTx, "mail_tx", "alice@example.com"],
  ] as const) {
    const row = byT.get(t);
    assert.ok(row, `${kind} line present`);
    assert.equal(row.v, 1, `${kind}: store-stamped version`);
    assert.equal(row.t, t, `${kind}: caller's t verbatim`);
    assert.equal(row.kind, kind);
    assert.equal(row.counterpart, counterpart);
  }
});

test("overlong surface, tool, and counterpart are each clamped to exactly 200 chars", () => {
  const long = "x".repeat(250);
  recordSignal({ t: T.clampedTool, kind: "tool", surface: `mail-${long}`, tool: `bash-${long}`, ok: false });
  recordSignal({ t: T.clampedSms, kind: "sms_tx", counterpart: `group:${long}` });

  const byT = new Map(rows().map((r) => [r.t, r]));
  const tool = byT.get(T.clampedTool);
  assert.ok(tool, "clamped tool line present");
  assert.equal(tool.surface?.length, 200, "surface clamped to exactly 200");
  assert.equal(tool.surface, `mail-${long}`.slice(0, 200), "clamped keeps the leading 200 chars");
  assert.equal(tool.tool?.length, 200, "tool clamped to exactly 200");
  assert.equal(tool.tool, `bash-${long}`.slice(0, 200));

  const sms = byT.get(T.clampedSms);
  assert.ok(sms, "clamped sms line present");
  assert.equal(sms.counterpart?.length, 200, "counterpart clamped to exactly 200");
  assert.equal(sms.counterpart, `group:${long}`.slice(0, 200));
});

test("USAGE_DIR_OVERRIDE is respected: signals.jsonl lands in the override dir", () => {
  const other = mkdtempSync(join(tmpdir(), "signals-other-"));
  const saved = process.env.USAGE_DIR_OVERRIDE;
  try {
    process.env.USAGE_DIR_OVERRIDE = other;
    recordSignal({ t: 1755172800800, kind: "mail_rx", counterpart: "override@example.com" });
    const otherFile = join(other, "signals.jsonl");
    assert.ok(existsSync(otherFile), "file created in the (new) override dir, not the default");
    const row = JSON.parse(readFileSync(otherFile, "utf8").trim().split("\n")[0]) as ParsedEvent;
    assert.equal(row.v, 1);
    assert.equal(row.counterpart, "override@example.com");
  } finally {
    process.env.USAGE_DIR_OVERRIDE = saved;
    rmSync(other, { recursive: true, force: true });
  }
});

test("caller-owned v is a compile-time error (@ts-expect-error)", () => {
  // @ts-expect-error -- SignalInput carries no `v`; the store stamps it. If the
  // type ever stops rejecting a caller-supplied v, this unused directive fails
  // `tsc --noEmit`, so the invariant cannot silently erode.
  recordSignal({ t: T.tsErr, kind: "sms_rx", counterpart: "+15550001111", v: 1 });
});

test("a runtime caller's smuggled v:999 persists as v:1 (spread order, not just types)", () => {
  // TypeScript's excess-property protection vanishes at runtime, so the store's
  // serialization itself must enforce store ownership: input spread FIRST, v:1
  // stamped LAST -- a widened JS object cannot override the version.
  const widened = recordSignal as unknown as (input: Record<string, unknown>) => void;
  widened({ t: T.smuggled, kind: "mail_tx", counterpart: "eve@example.com", v: 999 });
  const row = rows().find((r) => r.t === T.smuggled);
  assert.ok(row, "smuggled line persisted");
  assert.equal(row.v, 1, "store-owned v wins over the caller's 999");
  assert.equal(row.kind, "mail_tx");
});

test("recordSignal never throws when the override dir sits under an existing regular file (ENOTDIR)", () => {
  const saved = process.env.USAGE_DIR_OVERRIDE;
  // Same deterministic failure injection as usage-store.test.ts: a regular file
  // in the path makes mkdirSync fail fast with ENOTDIR (never chmod, never /proc).
  const notADir = join(DIR, "not-a-dir");
  writeFileSync(notADir, "x");
  try {
    process.env.USAGE_DIR_OVERRIDE = join(notADir, "sub");
    assert.doesNotThrow(() => recordSignal({ t: T.enotdir, kind: "sms_rx", counterpart: "+15559990000" }));
  } finally {
    process.env.USAGE_DIR_OVERRIDE = saved;
  }
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
