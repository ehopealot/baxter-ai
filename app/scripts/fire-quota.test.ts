// Durable UTC-date agent-run quota reservations (2026-08-20 system scheduled
// tasks, T6). Every test points SCHEDULE_DIR_OVERRIDE at a fresh temp dir so
// nothing here ever touches the real schedule state; "today" is always an
// INJECTED instant so seeding/rollover assertions never depend on the ambient
// wall-clock date the suite happens to run at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { reserveAgentRunSlot, releaseAgentRunSlot } from "./fire-quota.ts";
import type { QuotaState } from "./fire-quota.ts";

function freshDir(): string {
  const dir = mkdtempSync(pjoin(tmpdir(), "quota-"));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  return dir;
}
const quotaFile = (dir: string) => pjoin(dir, "fire-quota.json");
const readState = (dir: string) => JSON.parse(readFileSync(quotaFile(dir), "utf8")) as QuotaState;
const writeState = (dir: string, s: QuotaState) => writeFileSync(quotaFile(dir), JSON.stringify(s, null, 2));
// task-log.jsonl lines dated at the given ISO ts values (outcome varies per fixture)
const writeLog = (dir: string, lines: Array<{ ts: string; outcome: "completed" | "failed" | "skipped" }>) =>
  writeFileSync(pjoin(dir, "task-log.jsonl"), lines.map((l) => JSON.stringify({ ts: l.ts, id: "x", outcome: l.outcome }) + "\n").join(""));

test("first use seeds the window from fireCountToday at the INJECTED instant's UTC day, never the ambient date", async () => {
  const dir = freshDir();
  const injected = new Date("2024-05-10T12:00:00Z");
  writeLog(dir, [
    { ts: "2024-05-10T08:00:00Z", outcome: "completed" },
    { ts: "2024-05-10T09:00:00Z", outcome: "failed" },                       // non-skipped counts
    { ts: "2024-05-10T10:00:00Z", outcome: "skipped" },                      // excluded from the count
    { ts: new Date().toISOString(), outcome: "completed" },                   // real-today decoys:
    { ts: new Date().toISOString(), outcome: "completed" },
    { ts: new Date().toISOString(), outcome: "completed" },                   // ambient-date seeding would read 3, not 2
  ]);
  const r = await reserveAgentRunSlot(injected, 10, "task-a");
  assert.ok(r, "3-line legacy day under cap 10 -> granted");
  const state = readState(dir);
  assert.equal(state.version, 1);
  assert.equal(state.date, "2024-05-10");
  const seeds = state.reservations.filter((x) => x.task === "legacy-seed");
  assert.equal(seeds.length, 2, "seeds exactly the injected day's non-skipped count");
  assert.equal(state.reservations.length, 3, "2 seeds + the granted reservation");
  const mine = state.reservations.find((x) => x.task === "task-a");
  assert.ok(mine, "the granted reservation is bound to the caller's task");
  assert.equal(mine.id, r.token, "its id is the returned token");
  assert.equal(mine.ts, injected.toISOString(), "timestamped at the injected instant");
});

test("reserve under the cap persists a unique durable token that survives re-read", async () => {
  const dir = freshDir();
  const now = new Date("2026-03-05T15:00:00Z");
  const a = await reserveAgentRunSlot(now, 2, "t1");
  const b = await reserveAgentRunSlot(now, 2, "t2");
  assert.ok(a && b, "both granted (empty log seeds 0)");
  assert.notEqual(a.token, b.token, "tokens are unique");
  const state = readState(dir);
  assert.deepEqual([...state.reservations.map((x) => x.id)].sort(), [a.token, b.token].sort());
  assert.ok(state.reservations.every((x) => typeof x.ts === "string" && x.ts.length > 0));
});

test("an ALREADY-VALID same-day full window returns null and writes nothing", async () => {
  const dir = freshDir();
  const now = new Date("2026-03-05T15:00:00Z");
  assert.ok(await reserveAgentRunSlot(now, 1, "t1"), "first fills the cap-1 window");
  const before = readFileSync(quotaFile(dir), "utf8");
  const beforeMtime = statSync(quotaFile(dir)).mtimeMs;
  await new Promise((r) => setTimeout(r, 10)); // a real rewrite would move mtime even at coarse granularity
  const r = await reserveAgentRunSlot(now, 1, "t2");
  assert.equal(r, null, "denied: window full, state unchanged by this call");
  assert.equal(readFileSync(quotaFile(dir), "utf8"), before, "byte-identical content");
  assert.equal(statSync(quotaFile(dir)).mtimeMs, beforeMtime, "file not rewritten");
});

test("a crash after reserving (token never released) conservatively burns the slot", async () => {
  freshDir(); // side effect: installs SCHEDULE_DIR_OVERRIDE (no per-test binding needed here)
  const now = new Date("2026-03-05T15:00:00Z");
  const a = await reserveAgentRunSlot(now, 1, "t1");
  assert.ok(a);
  assert.equal(await reserveAgentRunSlot(now, 1, "t2"), null, "unreleased token still occupies the window");
  await releaseAgentRunSlot(a.token); // only an explicit release restores capacity
  assert.ok(await reserveAgentRunSlot(now, 1, "t3"), "released slot is reusable the same day");
});

test("SEED-AT-CAP DURABILITY: a denied first use still persists the seeded window, and the migration is derived exactly once", async () => {
  const dir = freshDir();
  const injected = new Date("2024-06-01T10:00:00Z");
  writeLog(dir, [
    { ts: "2024-06-01T08:00:00Z", outcome: "completed" },
    { ts: "2024-06-01T09:00:00Z", outcome: "completed" }, // legacy count = 2 = cap
  ]);
  const r = await reserveAgentRunSlot(injected, 2, "x");
  assert.equal(r, null, "denied: the seeding already filled the cap");
  const state = readState(dir); // the file EXISTS despite the denial
  assert.equal(state.version, 1);
  assert.equal(state.date, "2024-06-01");
  assert.equal(state.reservations.length, 2);
  assert.ok(state.reservations.every((x) => x.task === "legacy-seed"), "the persisted state is the seed itself");
  // the next same-day reserve READS this persisted file, never re-derives the
  // migration: hand-trim to cap-1 with the legacy log still AT cap -> a token
  // is granted; an implementation that re-seeded from the log would stay full.
  writeState(dir, { ...state, reservations: state.reservations.slice(0, 1) });
  const r2 = await reserveAgentRunSlot(injected, 2, "y");
  assert.ok(r2, "granted from the trimmed persisted state");
  assert.equal(readState(dir).reservations.length, 2);
});

test("DENIAL PERSISTENCE, corrupt file: recovery persists the re-seeded state even though the reserve is denied", async () => {
  const dir = freshDir();
  const injected = new Date("2024-07-01T10:00:00Z");
  writeLog(dir, [
    { ts: "2024-07-01T08:00:00Z", outcome: "completed" },
    { ts: "2024-07-01T08:30:00Z", outcome: "completed" },
    { ts: "2024-07-01T09:00:00Z", outcome: "completed" }, // legacy count = 3 = cap
  ]);
  writeFileSync(quotaFile(dir), "{not json at all");
  const r = await reserveAgentRunSlot(injected, 3, "x");
  assert.equal(r, null, "denied at cap");
  const state = readState(dir);
  assert.equal(state.version, 1, "corruption recovered and persisted durably");
  assert.equal(state.date, "2024-07-01");
  assert.equal(state.reservations.length, 3);
  assert.ok(state.reservations.every((x) => x.task === "legacy-seed"));
});

test("DENIAL PERSISTENCE, version-mismatched file: recovered and persisted like corruption", async () => {
  const dir = freshDir();
  const injected = new Date("2024-07-01T10:00:00Z");
  writeLog(dir, [
    { ts: "2024-07-01T08:00:00Z", outcome: "completed" },
    { ts: "2024-07-01T09:00:00Z", outcome: "completed" },
  ]);
  writeState(dir, { version: 2 as unknown as 1, date: "2024-07-01", reservations: [{ id: "z", task: "old", ts: "2024-07-01T07:00:00Z" }] });
  const r = await reserveAgentRunSlot(injected, 2, "x");
  assert.equal(r, null, "denied: recovered+seeded window is already full");
  const state = readState(dir);
  assert.equal(state.version, 1);
  assert.equal(state.date, "2024-07-01");
  assert.deepEqual(state.reservations.map((x) => x.task), ["legacy-seed", "legacy-seed"], "v2 state discarded, re-seeded from the log");
});

test("DENIAL PERSISTENCE, malformed-but-parseable v1 entries: recovered like corruption, never counted", async () => {
  // A v1 file that parses but carries a wrong-shaped reservation entry is
  // corruption. Without full-shape validation a [null] entry counted toward
  // the cap (wrongly denying a slot) and crashed releaseAgentRunSlot's some()
  // on the atomic-refund path; the recovery re-seeds from the legacy log and
  // persists the denied window exactly like an unparseable file.
  const malformedEntries: Array<unknown> = [
    [null],                                                        // null entry: pre-fix crash + phantom cap use
    [{ task: "t", ts: "2024-07-01T07:00:00Z" }],                  // missing id
    [{ id: "", task: "t", ts: "2024-07-01T07:00:00Z" }],          // empty (not a non-empty string) id
    [{ id: 7, task: "t", ts: "2024-07-01T07:00:00Z" }],           // non-string id
    [{ id: "z", task: 7, ts: "2024-07-01T07:00:00Z" }],           // non-string task
    [{ id: "z", task: "t", ts: false }],                          // non-string ts
  ];
  for (const reservations of malformedEntries) {
    const dir = freshDir();
    const injected = new Date("2024-07-01T10:00:00Z");
    writeLog(dir, [
      { ts: "2024-07-01T08:00:00Z", outcome: "completed" },
      { ts: "2024-07-01T08:30:00Z", outcome: "completed" },
      { ts: "2024-07-01T09:00:00Z", outcome: "completed" }, // legacy count = 3 = cap
    ]);
    writeFileSync(quotaFile(dir), JSON.stringify({ version: 1, date: "2024-07-01", reservations }));
    const r = await reserveAgentRunSlot(injected, 3, "x");
    assert.equal(r, null, "denied at cap after re-seeding: the malformed entry was discarded, not counted");
    const state = readState(dir);
    assert.equal(state.version, 1, "malformed v1 recovered and persisted durably");
    assert.equal(state.date, "2024-07-01");
    assert.equal(state.reservations.length, 3);
    assert.ok(state.reservations.every((x) => x.task === "legacy-seed"));
  }
});

test("a v1 file with a malformed or IMPOSSIBLE date token is corruption (re-seed), never a rollover reset", async () => {
  // A garbage or impossible date differs from today, so a shape-blind
  // readState routes it to the rollover path: reset to empty and GRANT. Full
  // validation -- regex shape PLUS a real-calendar round-trip -- must send it
  // to corruption recovery instead: re-seed from the legacy log at the
  // injected day, deny at cap, persist durably. Impossible dates (Feb 30,
  // month 13, 99-99) pass the regex but no UTC instant carries them, so they
  // are every bit as much corruption as a garbage token.
  for (const date of ["2024-7-1", "garbage", "2024-02-30", "2024-13-01", "2024-99-99"]) {
    const dir = freshDir();
    const injected = new Date("2024-07-01T10:00:00Z");
    writeLog(dir, [
      { ts: "2024-07-01T08:00:00Z", outcome: "completed" },
      { ts: "2024-07-01T09:00:00Z", outcome: "completed" }, // legacy count = 2 = cap
    ]);
    writeState(dir, { version: 1, date, reservations: [] });
    const r = await reserveAgentRunSlot(injected, 2, "x");
    assert.equal(r, null, "denied at cap: re-seeded, not rolled over (a rollover reset would grant)");
    const state = readState(dir);
    assert.equal(state.date, "2024-07-01", "recovered at the injected day, the malformed date discarded");
    assert.deepEqual(state.reservations.map((x) => x.task), ["legacy-seed", "legacy-seed"]);
  }
});

test("DUPLICATE reservation ids are corruption: a hand-edited v1 file repeating one id re-seeds from the log and denies at cap (fail-closed), persisting the recovered state", async () => {
  // releaseAgentRunSlot's filter(r => r.id !== token) removes EVERY entry
  // sharing a token, so a duplicate-id file would let one release free
  // multiple slots from a single token and bypass the durable cap. The
  // cross-entry uniqueness check sends such a file to corruption recovery
  // instead: discard the file, re-seed from the legacy log at the INJECTED
  // day, deny at cap, persist durably. Live system-written files never trip
  // it -- minted tokens and seed ids are unique by construction.
  const dir = freshDir();
  const injected = new Date("2024-07-01T10:00:00Z");
  writeLog(dir, [
    { ts: "2024-07-01T08:00:00Z", outcome: "completed" },
    { ts: "2024-07-01T09:00:00Z", outcome: "completed" }, // legacy count = 2 = cap
  ]);
  const dup = { id: "dup-token", task: "hand-edited", ts: "2024-07-01T07:00:00Z" };
  writeState(dir, { version: 1, date: "2024-07-01", reservations: [dup, dup, { id: "other", task: "t", ts: "2024-07-01T07:30:00Z" }] });
  const r = await reserveAgentRunSlot(injected, 2, "x");
  assert.equal(r, null, "denied: the duplicate-id file was discarded as corruption and the re-seed already fills the cap");
  const state = readState(dir); // the recovery is persisted despite the denial
  assert.equal(state.version, 1);
  assert.equal(state.date, "2024-07-01");
  assert.equal(state.reservations.length, 2);
  assert.ok(state.reservations.every((x) => x.task === "legacy-seed"), "re-seeded from the log, never from the corrupted file");
  assert.equal(new Set(state.reservations.map((x) => x.id)).size, state.reservations.length, "the recovered state's ids are unique");
});

test("release against a pre-existing malformed v1 file is a no-op, never a crash", async () => {
  // Pre-fix, reservations.some(r => r.id === token) threw a TypeError on a
  // null entry, crashing the atomic-refund path and burning the slot.
  for (const reservations of [[null], [{ id: 7, task: "t", ts: "x" }]]) {
    const dir = freshDir();
    const before = JSON.stringify({ version: 1, date: "2024-07-01", reservations }, null, 2);
    writeFileSync(quotaFile(dir), before);
    await releaseAgentRunSlot("any-token"); // resolves without throwing
    assert.equal(readFileSync(quotaFile(dir), "utf8"), before, "malformed state left untouched (no write)");
  }
});

test("release against a duplicate-id file is a no-op: the corrupted file is never trusted to free multiple slots from one token", async () => {
  // Pre-fix, releasing the duplicated token would filter BOTH entries out,
  // freeing two slots from one token and failing the cap open. With the
  // uniqueness check the file reads as corruption, so release leaves it
  // byte-identical (no write) like any other malformed file.
  const dir = freshDir();
  const dup = { id: "dup-token", task: "hand-edited", ts: "2024-07-01T07:00:00Z" };
  const state = { version: 1, date: "2024-07-01", reservations: [dup, dup, { id: "other", task: "t", ts: "2024-07-01T07:30:00Z" }] };
  const before = JSON.stringify(state, null, 2);
  writeFileSync(quotaFile(dir), before);
  await releaseAgentRunSlot("dup-token"); // resolves without throwing
  assert.equal(readFileSync(quotaFile(dir), "utf8"), before, "duplicate-id state left untouched (no write, no multi-slot free)");
  await releaseAgentRunSlot("other"); // same for any token in the corrupted file
  assert.equal(readFileSync(quotaFile(dir), "utf8"), before);
});

test("UTC rollover resets to empty without re-seeding from the log", async () => {
  const dir = freshDir();
  writeLog(dir, [
    { ts: "2024-07-01T08:00:00Z", outcome: "completed" },
    { ts: "2024-07-01T09:00:00Z", outcome: "completed" }, // day-1 legacy count 2
    { ts: "2024-07-02T08:00:00Z", outcome: "completed" },
    { ts: "2024-07-02T09:00:00Z", outcome: "completed" },
    { ts: "2024-07-02T10:00:00Z", outcome: "completed" }, // day-2 legacy count 3 (a buggy re-seed would import these)
  ]);
  const r1 = await reserveAgentRunSlot(new Date("2024-07-01T12:00:00Z"), 3, "a");
  assert.ok(r1);
  assert.equal(readState(dir).reservations.length, 3, "day 1: 2 seeds + 1 grant");
  const r2 = await reserveAgentRunSlot(new Date("2024-07-02T12:00:00Z"), 3, "b");
  assert.ok(r2);
  const state = readState(dir);
  assert.equal(state.date, "2024-07-02");
  assert.equal(state.reservations.length, 1, "rolled over to EMPTY then granted one - no legacy-seed entries from day 2's log");
  assert.ok(state.reservations.every((x) => x.task !== "legacy-seed"));
});

test("DENIAL PERSISTENCE, rollover: a valid prior-day file at cap 0 persists the rolled-over empty state", async () => {
  const dir = freshDir();
  writeState(dir, { version: 1, date: "2024-07-01", reservations: [{ id: "old", task: "t", ts: "2024-07-01T08:00:00Z" }] });
  const r = await reserveAgentRunSlot(new Date("2024-07-02T09:00:00Z"), 0, "x");
  assert.equal(r, null, "cap 0 always denies");
  assert.deepEqual(readState(dir), { version: 1, date: "2024-07-02", reservations: [] }, "the reset is durable, never re-derived from the log");
});

test("release removes exactly its own token; idempotent; never another's", async () => {
  const dir = freshDir();
  const now = new Date("2026-03-05T15:00:00Z");
  const a = await reserveAgentRunSlot(now, 2, "a");
  const b = await reserveAgentRunSlot(now, 2, "b");
  assert.ok(a && b);
  await releaseAgentRunSlot(a.token);
  assert.deepEqual(readState(dir).reservations.map((x) => x.id), [b.token], "exactly its own token removed");
  await releaseAgentRunSlot(a.token); // repeat release: no-op
  assert.deepEqual(readState(dir).reservations.map((x) => x.id), [b.token]);
  await releaseAgentRunSlot("never-issued-token"); // unknown token: no-op
  assert.deepEqual(readState(dir).reservations.map((x) => x.id), [b.token], "never removed another fire's reservation");
});

test("CONCURRENCY: with exactly one slot left, two simultaneous reserves yield exactly one token and one null", async () => {
  const dir = freshDir();
  const now = new Date("2024-08-01T12:00:00Z");
  writeState(dir, { version: 1, date: "2024-08-01", reservations: [{ id: "taken", task: "z", ts: "2024-08-01T08:00:00Z" }] });
  const [r1, r2] = await Promise.all([
    reserveAgentRunSlot(now, 2, "A"),
    reserveAgentRunSlot(now, 2, "B"),
  ]);
  const tokens = [r1, r2].filter((r): r is { token: string } => r !== null);
  const nulls = [r1, r2].filter((r) => r === null);
  assert.equal(tokens.length, 1, "exactly one contender wins the last slot");
  assert.equal(nulls.length, 1);
  const state = readState(dir);
  assert.equal(state.reservations.length, 2, "the pre-existing reservation + exactly one from the pair (atomic check-and-record)");
  assert.ok(state.reservations.some((x) => x.id === tokens[0].token));
});
