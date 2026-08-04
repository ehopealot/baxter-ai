import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllowlist, writeAllowlist } from "./allowlist.ts";

function tmp(): string { return join(mkdtempSync(join(tmpdir(), "allow-")), "allowlist.json"); }

test("reads the file when present, ignoring env", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ senders: ["a@x.com"], recipients: ["b@x.com"], version: 4 }));
  assert.deepEqual(loadAllowlist({ ALLOWED_SENDERS: "z@x.com" } as any, p), { senders: ["a@x.com"], recipients: ["b@x.com"], version: 4 });
});

test("falls back to the env seed when the file is absent (version 0)", () => {
  assert.deepEqual(loadAllowlist({ ALLOWED_SENDERS: "a@x.com, b@x.com", ALLOWED_RECIPIENTS: "c@x.com" } as any, tmp()),
    { senders: ["a@x.com", "b@x.com"], recipients: ["c@x.com"], version: 0 });
});

test("a corrupt file falls back to env, never to allow-all, and logs the abnormal fallback", () => {
  const p = tmp(); writeFileSync(p, "{not json");
  const errSpy = mock.method(console, "error", () => {});
  try {
    assert.deepEqual(loadAllowlist({ ALLOWED_SENDERS: "a@x.com" } as any, p), { senders: ["a@x.com"], recipients: [], version: 0 });
    assert.equal(errSpy.mock.calls.length, 1);
    assert.match(errSpy.mock.calls[0].arguments[0], /corrupt JSON/);
  } finally {
    errSpy.mock.restore();
  }
});

test("a missing file falls back to env silently (ENOENT is the normal not-yet-provisioned case)", () => {
  const errSpy = mock.method(console, "error", () => {});
  try {
    loadAllowlist({ ALLOWED_SENDERS: "a@x.com" } as any, tmp());
    assert.equal(errSpy.mock.calls.length, 0);
  } finally {
    errSpy.mock.restore();
  }
});

test("empty env + no file => nobody (fail-closed)", () => {
  assert.deepEqual(loadAllowlist({} as any, tmp()), { senders: [], recipients: [], version: 0 });
});

test("loadAllowlist never creates the file (readers are pure)", () => {
  const p = tmp();
  loadAllowlist({ ALLOWED_SENDERS: "a@x.com" } as any, p);
  assert.throws(() => readFileSync(p, "utf8")); // still absent
});

test("writeAllowlist writes atomically at 0600 and round-trips", () => {
  const p = tmp();
  writeAllowlist({ senders: ["a@x.com"], recipients: ["a@x.com"], version: 2 }, p);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { senders: ["a@x.com"], recipients: ["a@x.com"], version: 2 });
});
