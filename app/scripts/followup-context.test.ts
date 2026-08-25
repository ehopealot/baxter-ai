import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FOLLOW_UP_CONTEXT_ENV,
  FOLLOW_UP_CONTEXT_MAX_AGE_MS,
  FOLLOW_UP_CONTEXT_MAX_BYTES,
  createFollowUpRunContext,
  loadFollowUpRunContext,
} from "./followup-context.ts";

function temp(): string { return mkdtempSync(join(tmpdir(), "followup-context-")); }

test("creates all exact contexts as owner-only regular files with opaque tokens", () => {
  const dir = temp();
  try {
    const origins = [
      { surface: "sms" as const, conversation_id: "+15551234567", phone: "+15551234567" },
      { surface: "sms-group" as const, conversation_id: "group:grp_family", group_id: "grp_family" },
      { surface: "mail" as const, thread_id: "resend:member@example.com:abc" },
      { surface: "home-chat" as const, chat_id: "wc-7", author_id: "member:member@example.com" },
    ];
    for (const origin of origins) {
      const handle = createFollowUpRunContext(origin, { dir });
      const stat = lstatSync(handle.path);
      assert.equal(stat.isFile(), true);
      assert.equal(stat.mode & 0o777, 0o600);
      assert.match(handle.context.turn_token, /^[0-9a-f]{64}$/);
      assert.deepEqual(loadFollowUpRunContext({ [FOLLOW_UP_CONTEXT_ENV]: handle.path }), handle.context);
      const stored = JSON.parse(readFileSync(handle.path, "utf8"));
      assert.deepEqual(stored.context, handle.context);
      assert.equal(stored.lease.pid, process.pid);
      assert.equal(typeof stored.lease.process_start, "string");
      handle.dispose();
      handle.dispose();
      assert.throws(() => lstatSync(handle.path), /ENOENT/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loader refuses missing, stale, symlinked, wrong-mode, wrong-owner, and malformed context", () => {
  const dir = temp();
  try {
    assert.throws(() => loadFollowUpRunContext({}), /context path is missing/);
    assert.throws(() => loadFollowUpRunContext({ [FOLLOW_UP_CONTEXT_ENV]: join(dir, "gone") }), /unavailable/);
    const good = createFollowUpRunContext({ surface: "mail", thread_id: "resend:member@example.com:abc" }, { dir });
    const link = join(dir, "link");
    symlinkSync(good.path, link);
    assert.throws(() => loadFollowUpRunContext({ [FOLLOW_UP_CONTEXT_ENV]: link }), /regular file/);
    chmodSync(good.path, 0o644);
    assert.throws(() => loadFollowUpRunContext({ [FOLLOW_UP_CONTEXT_ENV]: good.path }), /mode 0600/);
    chmodSync(good.path, 0o600);
    assert.throws(() => loadFollowUpRunContext({ [FOLLOW_UP_CONTEXT_ENV]: good.path }, { uid: (process.getuid?.() ?? 0) + 1 }), /owner/);
    writeFileSync(good.path, "not-json", { mode: 0o600 });
    assert.throws(() => loadFollowUpRunContext({ [FOLLOW_UP_CONTEXT_ENV]: good.path }), /malformed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exact schema rejects extra keys, weak tokens, unsupported routes, and conversation mismatches", () => {
  const dir = temp();
  mkdirSync(dir, { recursive: true });
  try {
    const handle = createFollowUpRunContext({ surface: "mail", thread_id: "resend:member@example.com:abc" }, { dir });
    const stored = JSON.parse(readFileSync(handle.path, "utf8"));
    const values = [
      { version: 1, turn_token: "a".repeat(64), surface: "sms", conversation_id: "+15551234567", phone: "+15551234567", extra: true },
      { version: 1, turn_token: "weak", surface: "sms", conversation_id: "+15551234567", phone: "+15551234567" },
      { version: 1, turn_token: "a".repeat(64), surface: "sms", conversation_id: "+15550000000", phone: "+15551234567" },
      { version: 1, turn_token: "a".repeat(64), surface: "sms-group", conversation_id: "group:wrong", group_id: "grp_family" },
      { version: 1, turn_token: "a".repeat(64), surface: "discord", channel_id: "1" },
    ];
    for (const value of values) {
      writeFileSync(handle.path, JSON.stringify({ ...stored, context: value }), { mode: 0o600 });
      assert.throws(() => loadFollowUpRunContext({ [FOLLOW_UP_CONTEXT_ENV]: handle.path }));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lease rejects dead creators, PID-reuse start mismatches, and expired contexts", () => {
  const dir = temp();
  try {
    const handle = createFollowUpRunContext({ surface: "mail", thread_id: "resend:member@example.com:abc" }, { dir });
    const original = JSON.parse(readFileSync(handle.path, "utf8"));
    const cases = [
      { label: "dead owner", lease: { ...original.lease, pid: 1_000_000_000 }, re: /owner process is not live/ },
      { label: "PID reuse", lease: { ...original.lease, process_start: String(BigInt(original.lease.process_start) + 1n) }, re: /process identity/ },
      { label: "expired", lease: { ...original.lease, created_at: Date.now() - FOLLOW_UP_CONTEXT_MAX_AGE_MS - 1 }, re: /expired/ },
    ];
    for (const scenario of cases) {
      writeFileSync(handle.path, JSON.stringify({ ...original, lease: scenario.lease }), { mode: 0o600 });
      assert.throws(() => loadFollowUpRunContext({ [FOLLOW_UP_CONTEXT_ENV]: handle.path }), scenario.re, scenario.label);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("secure fd read resists path replacement and enforces exact maximum bytes", () => {
  const dir = temp();
  try {
    const first = createFollowUpRunContext({ surface: "mail", thread_id: "resend:first@example.com:one" }, { dir });
    const second = createFollowUpRunContext({ surface: "mail", thread_id: "resend:second@example.com:two" }, { dir });
    const moved = join(dir, "opened-inode.json");
    const loaded = loadFollowUpRunContext({ [FOLLOW_UP_CONTEXT_ENV]: first.path }, { afterOpen: () => {
      renameSync(first.path, moved);
      symlinkSync(second.path, first.path);
    } });
    assert.equal(loaded.surface, "mail");
    if (loaded.surface === "mail") assert.equal(loaded.thread_id, "resend:first@example.com:one", "reads the securely opened inode, not the swapped path");

    rmSync(first.path, { force: true });
    renameSync(moved, first.path);
    const raw = readFileSync(first.path, "utf8");
    writeFileSync(first.path, raw + " ".repeat(FOLLOW_UP_CONTEXT_MAX_BYTES - Buffer.byteLength(raw)), { mode: 0o600 });
    assert.equal(loadFollowUpRunContext({ [FOLLOW_UP_CONTEXT_ENV]: first.path }).surface, "mail", "exact maximum is accepted");
    writeFileSync(first.path, readFileSync(first.path, "utf8") + "x", { mode: 0o600 });
    assert.throws(() => loadFollowUpRunContext({ [FOLLOW_UP_CONTEXT_ENV]: first.path }), /too large/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a normal CLI child can load the context only while its daemon owner remains live", () => {
  const dir = temp();
  try {
    const handle = createFollowUpRunContext({ surface: "mail", thread_id: "resend:member@example.com:abc" }, { dir });
    const moduleUrl = new URL("./followup-context.ts", import.meta.url).href;
    const script = `import { loadFollowUpRunContext as load, FOLLOW_UP_CONTEXT_ENV as key } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(load({ [key]: process.env.CTX })));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, CTX: handle.path } });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).thread_id, "resend:member@example.com:abc");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
