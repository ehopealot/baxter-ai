// Tests for householdTz (system-scheduled-tasks plan, T2): the ONE shared household
// timezone resolver. A valid BAXTER_TZ wins; an invalid/unset BAXTER_TZ falls back to a
// valid HEARTBEAT_TZ; both invalid or unset yields America/Los_Angeles. Garbage input
// never throws, and the result is always a zone Intl itself accepts, so callers can
// hand it straight to Intl without their own guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { householdTz } from "./household-tz.ts";

test("householdTz: valid BAXTER_TZ wins over HEARTBEAT_TZ", () => {
  assert.equal(householdTz({ BAXTER_TZ: "Europe/Berlin", HEARTBEAT_TZ: "Asia/Tokyo" }), "Europe/Berlin");
});

test("householdTz: valid BAXTER_TZ wins even when HEARTBEAT_TZ is invalid", () => {
  assert.equal(householdTz({ BAXTER_TZ: "Europe/Berlin", HEARTBEAT_TZ: "bogus/zone" }), "Europe/Berlin");
});

test("householdTz: invalid BAXTER_TZ falls back to a valid HEARTBEAT_TZ", () => {
  assert.equal(householdTz({ BAXTER_TZ: "Not/A Zone", HEARTBEAT_TZ: "America/New_York" }), "America/New_York");
});

test("householdTz: unset BAXTER_TZ uses a valid HEARTBEAT_TZ", () => {
  assert.equal(householdTz({ HEARTBEAT_TZ: "Europe/Paris" }), "Europe/Paris");
});

test("householdTz: empty-string BAXTER_TZ counts as unset, not as a zone", () => {
  assert.equal(householdTz({ BAXTER_TZ: "", HEARTBEAT_TZ: "Europe/Paris" }), "Europe/Paris");
});

test("householdTz: both invalid yields America/Los_Angeles", () => {
  assert.equal(householdTz({ BAXTER_TZ: "bogus/zone", HEARTBEAT_TZ: "also bogus" }), "America/Los_Angeles");
});

test("householdTz: both unset yields America/Los_Angeles", () => {
  assert.equal(householdTz({}), "America/Los_Angeles");
});

test("householdTz: never throws on garbage input; the result is always Intl-valid", () => {
  const garbage = ["", " ", "\x00America", "America/Los_Angeles/", "12", "utc/../utc", "🇺🇸", "GMT+25", "été", "America/Los_Angeles\x00"];
  for (const g of garbage) {
    let out: string | undefined;
    assert.doesNotThrow(() => { out = householdTz({ BAXTER_TZ: g, HEARTBEAT_TZ: g }); }, `garbage zones ${JSON.stringify(g)}`);
    assert.equal(typeof out, "string");
    // Whatever the fallback picks, callers may hand it straight to Intl unguarded.
    assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: out! }), `result zone ${JSON.stringify(out)}`);
  }
});

test("householdTz: no-argument call reads process.env", () => {
  const hadBaxter = process.env.BAXTER_TZ, hadHeartbeat = process.env.HEARTBEAT_TZ;
  try {
    process.env.BAXTER_TZ = "Asia/Tokyo";
    process.env.HEARTBEAT_TZ = "Europe/Paris";
    assert.equal(householdTz(), "Asia/Tokyo");
    process.env.BAXTER_TZ = "nonsense";
    assert.equal(householdTz(), "Europe/Paris");
  } finally {
    if (hadBaxter === undefined) delete process.env.BAXTER_TZ; else process.env.BAXTER_TZ = hadBaxter;
    if (hadHeartbeat === undefined) delete process.env.HEARTBEAT_TZ; else process.env.HEARTBEAT_TZ = hadHeartbeat;
  }
});
