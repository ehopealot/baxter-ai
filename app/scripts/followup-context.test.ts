import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import {
  FOLLOW_UP_CONTEXT_ENV,
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
      assert.deepEqual(JSON.parse(readFileSync(handle.path, "utf8")), handle.context);
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
    const path = join(dir, "ctx.json");
    const values = [
      { version: 1, turn_token: "a".repeat(64), surface: "sms", conversation_id: "+15551234567", phone: "+15551234567", extra: true },
      { version: 1, turn_token: "weak", surface: "sms", conversation_id: "+15551234567", phone: "+15551234567" },
      { version: 1, turn_token: "a".repeat(64), surface: "sms", conversation_id: "+15550000000", phone: "+15551234567" },
      { version: 1, turn_token: "a".repeat(64), surface: "sms-group", conversation_id: "group:wrong", group_id: "grp_family" },
      { version: 1, turn_token: "a".repeat(64), surface: "discord", channel_id: "1" },
    ];
    for (const value of values) {
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
      assert.throws(() => loadFollowUpRunContext({ [FOLLOW_UP_CONTEXT_ENV]: path }));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
