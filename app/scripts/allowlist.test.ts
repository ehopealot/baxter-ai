import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllowlist, writeAllowlist, nameForAddress } from "./allowlist.ts";

function tmp(): string { return join(mkdtempSync(join(tmpdir(), "allow-")), "allowlist.json"); }

test("reads the file when present, ignoring env", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ senders: ["a@x.com"], recipients: ["b@x.com"], version: 4 }));
  assert.deepEqual(loadAllowlist({ ALLOWED_SENDERS: "z@x.com" } as any, p), { senders: ["a@x.com"], recipients: ["b@x.com"], version: 4, names: {} });
});

test("falls back to the env seed when the file is absent (version 0)", () => {
  assert.deepEqual(loadAllowlist({ ALLOWED_SENDERS: "a@x.com, b@x.com", ALLOWED_RECIPIENTS: "c@x.com" } as any, tmp()),
    { senders: ["a@x.com", "b@x.com"], recipients: ["c@x.com"], version: 0, names: {} });
});

test("a corrupt file falls back to env, never to allow-all, and logs the abnormal fallback", () => {
  const p = tmp(); writeFileSync(p, "{not json");
  const errSpy = mock.method(console, "error", () => {});
  try {
    assert.deepEqual(loadAllowlist({ ALLOWED_SENDERS: "a@x.com" } as any, p), { senders: ["a@x.com"], recipients: [], version: 0, names: {} });
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
  assert.deepEqual(loadAllowlist({} as any, tmp()), { senders: [], recipients: [], version: 0, names: {} });
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

test("the names map round-trips, defaults to {} when absent, and drops non-string values", () => {
  const p = tmp();
  writeAllowlist({ senders: ["a@x.com"], recipients: ["a@x.com"], version: 3, names: { "a@x.com": "Al" } }, p);
  assert.deepEqual(loadAllowlist({}, p).names, { "a@x.com": "Al" });
  const p2 = tmp();
  writeAllowlist({ senders: [], recipients: [], version: 1 }, p2); // written without names
  assert.deepEqual(loadAllowlist({}, p2).names, {}, "absent names read as {}");
  // A hand-edited/garbage names field is sanitized to string->string, never trusted raw.
  writeFileSync(p2, JSON.stringify({ senders: [], recipients: [], version: 1, names: { good: "Sam", bad: 42, worse: null } }));
  assert.deepEqual(loadAllowlist({}, p2).names, { good: "Sam" });
});

test("nameForAddress resolves a canonical address to its name, else undefined", () => {
  const p = tmp();
  writeAllowlist({ senders: [], recipients: [], version: 1, names: { "erik@x.com": "Erik", "+15551234567": "Erik" } }, p);
  assert.equal(nameForAddress("erik@x.com", {}, p), "Erik");
  assert.equal(nameForAddress("+15551234567", {}, p), "Erik");
  assert.equal(nameForAddress("stranger@x.com", {}, p), undefined);
  assert.equal(nameForAddress("", {}, p), undefined);
});

// fix round 2: the read side (loadAllowlist) used a bare `typeof p.version === "number"` check,
// admitting the same NaN/Infinity/huge-double/fractional/negative class of absurd-but-JSON-
// expressible values home-bot.ts's applyMembersCommand write-side guard was already tightened
// against (fix round 1). A well-formed-JSON file is reachable this way even though home-bot.ts
// never writes such a value itself -- the file is also hand-editable (baxctl provisioning, an
// operator poking the config volume) -- so the read side must independently refuse to trust it.
// isSafeVersion (this file) is now the single shared predicate for both sides.

test("a well-formed file with an absurd version (1e300) loads with version 0, members intact (fail-closed, not fail-open)", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ senders: ["a@x.com"], recipients: ["b@x.com"], version: 1e300 }));
  assert.deepEqual(loadAllowlist({} as any, p), { senders: ["a@x.com"], recipients: ["b@x.com"], version: 0, names: {} });
});

test("a well-formed file with a negative or fractional version loads with version 0, members intact", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ senders: ["a@x.com"], recipients: ["b@x.com"], version: -1 }));
  assert.deepEqual(loadAllowlist({} as any, p), { senders: ["a@x.com"], recipients: ["b@x.com"], version: 0, names: {} });

  writeFileSync(p, JSON.stringify({ senders: ["a@x.com"], recipients: ["b@x.com"], version: 1.5 }));
  assert.deepEqual(loadAllowlist({} as any, p), { senders: ["a@x.com"], recipients: ["b@x.com"], version: 0, names: {} });
});
