import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { addressToken, automaticConsume, directConsume, inspectMorningHandoff, morningHandoffPath, setMorningHandoffStoreTestSeam, sharedClose } from "./morning-handoff-store.ts";

const occurrence = "2026-08-23T15:42:00.000Z";
const now = new Date("2026-08-23T12:00:00.000Z");
const alice = { emails: ["alice@example.com"], phones: ["+15551234567"] };
const bob = { emails: ["bob@example.com"], phones: ["+15557654321"] };

function isolated(name: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `morning-handoff-${name}-`));
  process.env.SCHEDULE_DIR_OVERRIDE = dir;
  return { dir, done: () => { delete process.env.SCHEDULE_DIR_OVERRIDE; rmSync(dir, { recursive: true, force: true }); } };
}

test("tokens are domain separated and direct consumption joins aliases", async () => {
  const { done } = isolated("aliases");
  try {
    assert.equal(addressToken("alice@example.com"), "cd96a7f3bcb7c1daca59008b412dc9d1af0ed22f1e0617c2ebcfbf3e96d4b3ce");
    assert.equal(await directConsume(occurrence, alice, null, [alice, bob], now), "direct-consumed");
    assert.equal((await inspectMorningHandoff(occurrence, now)).state, "open");
    assert.equal(await automaticConsume(occurrence, alice, [alice, bob], now), "already-consumed");
    assert.equal((await sharedClose(occurrence, true, now)).contextEligible, false);
  } finally { done(); }
});

test("every operation resolves an override set after import and bootstraps owner-only state", async () => {
  const first = isolated("first");
  try {
    assert.equal(morningHandoffPath(), join(first.dir, "morning-handoff.json"));
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "open", consumed: [] });
    const stat = lstatSync(join(first.dir, "morning-handoff.json"));
    assert.ok(stat.isFile());
    assert.equal(stat.mode & 0o077, 0);
    const second = mkdtempSync(join(tmpdir(), "morning-handoff-second-"));
    try {
      process.env.SCHEDULE_DIR_OVERRIDE = second;
      assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "open", consumed: [] });
      assert.equal(readFileSync(join(first.dir, "morning-handoff.json"), "utf8"), '{"version":1,"occurrences":{}}');
    } finally { rmSync(second, { recursive: true, force: true }); }
  } finally { first.done(); }
});

test("serialized winner table preserves winners and closes unsafe shared attempts", async () => {
  const cases: Array<[string, (roster: readonly typeof alice[]) => Promise<unknown>, unknown]> = [
    ["same direct", async roster => [await directConsume(occurrence, alice, null, roster, now), await directConsume(occurrence, alice, null, roster, now)], ["direct-consumed", "already-consumed"]],
    ["distinct directs", async roster => [await directConsume(occurrence, alice, null, roster, now), await directConsume(occurrence, bob, null, roster, now)], ["direct-consumed", "direct-consumed"]],
    ["direct then shared", async roster => [await directConsume(occurrence, alice, null, roster, now), await sharedClose(occurrence, true, now)], ["direct-consumed", { decision: "shared-closed", contextEligible: false }]],
    ["shared then direct", async roster => [await sharedClose(occurrence, true, now), await directConsume(occurrence, alice, null, roster, now)], [{ decision: "shared-closed", contextEligible: true }, "already-consumed"]],
    ["shared then shared", async () => [await sharedClose(occurrence, true, now), await sharedClose(occurrence, true, now)], [{ decision: "shared-closed", contextEligible: true }, { decision: "already-consumed", contextEligible: false }]],
    ["unsafe shared", async () => [await sharedClose(occurrence, false, now), await sharedClose(occurrence, true, now)], [{ decision: "shared-closed", contextEligible: false }, { decision: "already-consumed", contextEligible: false }]],
  ];
  for (const [name, run, expected] of cases) {
    const { done } = isolated(name);
    try { assert.deepEqual(await run([alice, bob]), expected, name); } finally { done(); }
  }
});

test("concurrent same-contact direct attempts elect one cross-surface winner", async () => {
  const { dir, done } = isolated("concurrent-same-contact");
  try {
    const outcomes = await Promise.all([
      directConsume(occurrence, alice, null, [alice, bob], now),
      directConsume(occurrence, alice, null, [alice, bob], now),
    ]);
    assert.deepEqual(outcomes.sort(), ["already-consumed", "direct-consumed"]);
    const persisted = JSON.parse(readFileSync(join(dir, "morning-handoff.json"), "utf8"));
    assert.deepEqual(persisted.occurrences[occurrence].consumed, [
      addressToken("alice@example.com"),
      addressToken("+15551234567"),
    ].sort(), "the sole winner persists the resolved contact's complete alias-token set");
  } finally { done(); }
});

test("the final direct winner closes without revoking its own decision", async () => {
  const { done } = isolated("final");
  try {
    assert.equal(await directConsume(occurrence, alice, null, [alice], now), "direct-consumed");
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "closed" });
    // An unmatched but admitted direct address has no resolved roster owner;
    // the empty current roster is vacuously covered and must close now.
    const emptyRosterOccurrence = "2026-08-24T15:42:00.000Z";
    assert.equal(await directConsume(emptyRosterOccurrence, null, "unmatched@example.com", [], now), "direct-consumed");
    assert.deepEqual(await inspectMorningHandoff(emptyRosterOccurrence, now), { state: "closed" });
  } finally { done(); }
});

test("invalid state repairs closed and never treats extant symlink paths as absent", async () => {
  const { dir, done } = isolated("repair");
  try {
    const sidecar = join(dir, "morning-handoff.json");
    writeFileSync(sidecar, "not json", { mode: 0o600 });
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" });
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "closed" });
    const target = join(dir, "outside.json");
    writeFileSync(target, '{"version":1,"occurrences":{}}');
    rmSync(sidecar);
    symlinkSync(target, sidecar);
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" });
    assert.equal(readFileSync(target, "utf8"), '{"version":1,"occurrences":{}}');
    rmSync(sidecar);
    symlinkSync(join(dir, "missing-target"), sidecar);
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" });
    assert.equal(lstatSync(sidecar).isSymbolicLink(), false, "repair atomically replaces a dangling sidecar link");
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "closed" });
  } finally { done(); }
});

test("directory sidecars and fatal invalid UTF-8 fail closed without becoming open", async () => {
  const { dir, done } = isolated("nonregular-and-utf8");
  try {
    const sidecar = join(dir, "morning-handoff.json");
    mkdirSync(sidecar);
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" });
    rmSync(sidecar, { recursive: true });
    writeFileSync(sidecar, Buffer.from([0xff, 0xfe]), { mode: 0o600 });
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" });
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "closed" });
  } finally { done(); }
});

test("corrupt over-limit input repairs only the current occurrence rather than selecting a best-effort occurrence", async () => {
  const { dir, done } = isolated("corrupt-over-limit");
  try {
    const consumed = Array.from({ length: 257 }, (_, index) => index.toString(16).padStart(64, "0"));
    const unrelated = "2026-08-22T15:42:00.000Z";
    writeFileSync(join(dir, "morning-handoff.json"), JSON.stringify({ version: 1, occurrences: {
      [unrelated]: { closed: false, consumed: [addressToken("bob@example.com")], updated_at: now.toISOString() },
      [occurrence]: { closed: false, consumed, updated_at: now.toISOString() },
    } }), { mode: 0o600 });
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "morning-handoff.json"), "utf8")).occurrences, {
      [occurrence]: { closed: true, consumed: [], updated_at: now.toISOString() },
    });
  } finally { done(); }
});

test("over-limit aliases repair to a closed-only occurrence rather than truncating", async () => {
  const { dir, done } = isolated("overflow");
  try {
    const aliases = Array.from({ length: 257 }, (_, n) => `person${n}@example.com`);
    assert.equal(await directConsume(occurrence, { emails: aliases, phones: [] }, null, [], now), "state-unavailable");
    const parsed = JSON.parse(readFileSync(join(dir, "morning-handoff.json"), "utf8"));
    assert.deepEqual(parsed.occurrences[occurrence], { closed: true, consumed: [], updated_at: now.toISOString() });
  } finally { done(); }
});

test("current-roster alias replacement and ownership transfer retain documented duplicate and skip outcomes", async () => {
  const replacement = isolated("roster-replacement");
  try {
    const oldAlice = { emails: ["alice-old@example.com"], phones: [] };
    const newAlice = { emails: ["alice-new@example.com"], phones: [] };
    const other = { emails: ["other@example.com"], phones: [] };
    assert.equal(await directConsume(occurrence, oldAlice, null, [oldAlice, other], now), "direct-consumed");
    assert.equal(await directConsume(occurrence, newAlice, null, [newAlice], now), "direct-consumed", "fresh aliases do not inherit a historical token");
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "closed" });
  } finally { replacement.done(); }

  const transfer = isolated("roster-transfer");
  try {
    const aliceBefore = { emails: ["shared@example.com"], phones: [] };
    const bobBefore = { emails: ["bob-before@example.com"], phones: [] };
    const aliceAfter = { emails: ["alice-after@example.com"], phones: [] };
    const bobAfter = { emails: ["shared@example.com"], phones: [] };
    assert.equal(await directConsume(occurrence, aliceBefore, null, [aliceBefore, bobBefore], now), "direct-consumed");
    assert.equal(await directConsume(occurrence, bobAfter, null, [aliceAfter, bobAfter], now), "already-consumed", "current ownership intersects the persisted token and skips");
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "open", consumed: [addressToken("shared@example.com")] });
  } finally { transfer.done(); }
});

test("concurrent distinct direct mutations are serialized without losing either winner", async () => {
  const { done } = isolated("concurrent");
  try {
    assert.deepEqual(await Promise.all([
      directConsume(occurrence, alice, null, [alice, bob], now),
      directConsume(occurrence, bob, null, [alice, bob], now),
    ]).then(outcomes => outcomes.sort()), ["direct-consumed", "direct-consumed"]);
    // The second winner is also the final current-roster recipient, so it closes
    // the occurrence while retaining both contacts' aliases in the durable state.
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "closed" });
    assert.equal(JSON.parse(readFileSync(join(process.env.SCHEDULE_DIR_OVERRIDE!, "morning-handoff.json"), "utf8")).occurrences[occurrence].consumed.length, 4);
  } finally { done(); }
});

test("byte retention prunes oldest non-current entries before closing a valid current mutation", async () => {
  const { dir, done } = isolated("byte-prune");
  try {
    const current = "2026-08-30T08:00:00.000Z";
    const token = (prefix: string, n: number) => addressToken(`${prefix}-${n}@example.com`);
    const occurrences: Record<string, unknown> = {};
    // Seven old entries plus a tiny current entry are valid but close to the
    // serialized cap. Adding the current aliases requires byte pruning.
    for (let day = 1; day <= 7; day++) {
      const key = new Date(Date.UTC(2026, 7, day, 8)).toISOString();
      occurrences[key] = { closed: false, consumed: Array.from({ length: 130 }, (_, n) => token(`old-${day}`, n)).sort(), updated_at: now.toISOString() };
    }
    occurrences[current] = { closed: false, consumed: [], updated_at: now.toISOString() };
    const sidecar = join(dir, "morning-handoff.json");
    writeFileSync(sidecar, JSON.stringify({ version: 1, occurrences }), { mode: 0o600 });
    const aliases = Array.from({ length: 200 }, (_, n) => `current-${n}@example.com`);
    assert.equal(await directConsume(current, { emails: aliases, phones: [] }, null, [], now), "direct-consumed");
    const saved = JSON.parse(readFileSync(sidecar, "utf8"));
    assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= 64 * 1024);
    assert.equal(saved.occurrences[current].consumed.length, 200, "current aliases are retained exactly");
    assert.equal(saved.occurrences["2026-08-01T08:00:00.000Z"], undefined, "oldest entry is pruned first");
    assert.equal(saved.occurrences["2026-08-02T08:00:00.000Z"], undefined, "byte pressure repeats pruning rather than stopping after one entry");
  } finally { done(); }
});

test("valid inspection is read-only and retention keeps current plus seven newest others", async () => {
  const { dir, done } = isolated("retention");
  try {
    for (let day = 1; day <= 9; day++) {
      const key = new Date(Date.UTC(2026, 7, day, 8, 0, 0)).toISOString();
      assert.equal(await directConsume(key, alice, null, [alice, bob], now), "direct-consumed");
    }
    const sidecar = join(dir, "morning-handoff.json");
    const before = readFileSync(sidecar);
    const inode = statSync(sidecar).ino;
    await inspectMorningHandoff(occurrence, now);
    assert.deepEqual(readFileSync(sidecar), before);
    assert.equal(statSync(sidecar).ino, inode, "inspection must not rewrite a valid ledger");
    const parsed = JSON.parse(before.toString());
    assert.equal(Object.keys(parsed.occurrences).length, 8);
    assert.ok(parsed.occurrences["2026-08-09T08:00:00.000Z"]);
    assert.equal(parsed.occurrences["2026-08-01T08:00:00.000Z"], undefined);
  } finally { done(); }
});

test("schema rejects every noncanonical and over-bound shape without selecting it", async () => {
  const { dir, done } = isolated("schema");
  try {
    const sidecar = join(dir, "morning-handoff.json");
    const valid = { version: 1, occurrences: { [occurrence]: { closed: false, consumed: [], updated_at: now.toISOString() } } };
    const invalid = [
      { ...valid, version: 2 },
      { ...valid, extra: true },
      { version: 1, occurrences: { [occurrence]: { ...valid.occurrences[occurrence], extra: true } } },
      { version: 1, occurrences: { "2026-08-23T15:42:00Z": valid.occurrences[occurrence] } },
      { version: 1, occurrences: { [occurrence]: { closed: false, consumed: [] } } },
      { version: 1, occurrences: { [occurrence]: { ...valid.occurrences[occurrence], closed: "false" } } },
      { version: 1, occurrences: { [occurrence]: { ...valid.occurrences[occurrence], updated_at: "2026-08-23T12:00:00Z" } } },
      { version: 1, occurrences: { [occurrence]: { ...valid.occurrences[occurrence], consumed: ["a".repeat(63)] } } },
      { version: 1, occurrences: { [occurrence]: { ...valid.occurrences[occurrence], consumed: ["a".repeat(65)] } } },
      { version: 1, occurrences: { [occurrence]: { ...valid.occurrences[occurrence], consumed: ["g".repeat(64)] } } },
      { version: 1, occurrences: { [occurrence]: { ...valid.occurrences[occurrence], consumed: ["A".repeat(64)] } } },
      { version: 1, occurrences: { [occurrence]: { ...valid.occurrences[occurrence], consumed: ["a".repeat(64), "a".repeat(64)] } } },
      { version: 1, occurrences: { [occurrence]: { ...valid.occurrences[occurrence], consumed: ["b".repeat(64), "a".repeat(64)] } } },
      { version: 1, occurrences: Object.fromEntries(Array.from({ length: 9 }, (_, n) => [new Date(Date.UTC(2026, 0, n + 1)).toISOString(), valid.occurrences[occurrence]])) },
    ];
    for (const value of invalid) {
      writeFileSync(sidecar, JSON.stringify(value), { mode: 0o600 });
      assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" });
    }
    writeFileSync(sidecar, "x".repeat(64 * 1024), { mode: 0o600 });
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" });
    writeFileSync(sidecar, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" });
  } finally { done(); }
});

test("exact token and byte caps accept the boundary and reject the next byte", async () => {
  const { dir, done } = isolated("exact-bounds");
  try {
    const sidecar = join(dir, "morning-handoff.json");
    const aliases = Array.from({ length: 256 }, (_, n) => `boundary-${n}@example.com`);
    assert.equal(await directConsume(occurrence, { emails: aliases, phones: [] }, null, [], now), "direct-consumed");
    assert.equal(JSON.parse(readFileSync(sidecar, "utf8")).occurrences[occurrence].consumed.length, 256);
    rmSync(sidecar);
    const occurrences: Record<string, unknown> = {};
    let remaining = 969;
    for (let day = 1; day <= 6; day++) {
      const count = Math.min(256, remaining); remaining -= count;
      const key = new Date(Date.UTC(2026, 0, day)).toISOString();
      occurrences[key] = { closed: false, consumed: Array.from({ length: count }, (_, n) => n.toString(16).padStart(64, "0")), updated_at: now.toISOString() };
    }
    const exact = JSON.stringify({ version: 1, occurrences });
    assert.equal(Buffer.byteLength(exact), 64 * 1024, "fixture is exactly the serialized byte cap");
    writeFileSync(sidecar, exact, { mode: 0o600 });
    assert.equal((await inspectMorningHandoff(occurrence, now)).state, "open");
    writeFileSync(sidecar, `${exact} `, { mode: 0o600 });
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" });
  } finally { done(); }
});

test("fault seam fails closed, cleans only owned temporaries, and preserves a collision", async () => {
  const { dir, done } = isolated("faults");
  try {
    const sidecar = join(dir, "morning-handoff.json");
    for (const fault of ["lock", "read", "create"] as const) {
      const restore = fault === "lock" ? setMorningHandoffStoreTestSeam({ lock: async () => { throw new Error("lock"); } })
        : fault === "read" ? setMorningHandoffStoreTestSeam({ readSync: () => { throw new Error("read"); } })
        : setMorningHandoffStoreTestSeam({ openSync: () => { throw new Error("create"); } });
      try { assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" }, fault); } finally { restore(); rmSync(sidecar, { force: true }); }
    }
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "open", consumed: [] });
    for (const fault of ["write", "rename"] as const) {
      const temp = `${sidecar}.forced-${fault}.tmp`;
      let observedMode: number | undefined;
      const restore = setMorningHandoffStoreTestSeam({ temporaryPath: () => temp, ...(fault === "write"
        ? { writeSync: ((fd: number, data: Uint8Array, offset = 0, length = data.byteLength - offset, position: number | null = null) => { writeSync(fd, data, offset, length, position); throw new Error("write"); }) as unknown as typeof writeSync }
        : { writeSync: ((fd: number, data: Uint8Array, offset = 0, length = data.byteLength - offset, position: number | null = null) => { observedMode = lstatSync(temp).mode & 0o777; return writeSync(fd, data, offset, length, position); }) as unknown as typeof writeSync, renameSync: () => { throw new Error("rename"); } }) });
      try { assert.equal(await directConsume(occurrence, alice, null, [alice], now), "state-unavailable"); }
      finally {
        restore(); assert.equal(lstatSync(temp, { throwIfNoEntry: false }), undefined, `${fault} cleans owned temp`);
        if (fault === "rename") assert.equal(observedMode! & 0o077, 0, "temporary is owner-only before publication");
      }
    }
    const collision = `${sidecar}.collision.tmp`;
    writeFileSync(collision, "do-not-delete", { mode: 0o600 });
    const restore = setMorningHandoffStoreTestSeam({ temporaryPath: () => collision });
    try { assert.equal(await directConsume(occurrence, alice, null, [alice], now), "state-unavailable"); }
    finally { restore(); assert.equal(readFileSync(collision, "utf8"), "do-not-delete"); }
  } finally { done(); }
});

test("mutation failures return fixed unavailable decisions and never replace directory sidecars", async () => {
  const { dir, done } = isolated("mutation-failures");
  try {
    const sidecar = join(dir, "morning-handoff.json");
    const unavailableShared = { decision: "state-unavailable", contextEligible: false };
    const lockRestore = setMorningHandoffStoreTestSeam({ lock: async () => { throw new Error("lock"); } });
    try {
      assert.equal(await directConsume(occurrence, alice, null, [alice], now), "state-unavailable");
      assert.equal(await automaticConsume(occurrence, alice, [alice], now), "state-unavailable");
      assert.deepEqual(await sharedClose(occurrence, true, now), unavailableShared);
    } finally { lockRestore(); }

    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "open", consumed: [] });
    const readRestore = setMorningHandoffStoreTestSeam({ readSync: () => { throw new Error("read"); } });
    try {
      assert.equal(await directConsume(occurrence, alice, null, [alice], now), "state-unavailable");
      assert.deepEqual(await sharedClose(occurrence, true, now), unavailableShared);
    } finally { readRestore(); }

    rmSync(sidecar);
    const createRestore = setMorningHandoffStoreTestSeam({ openSync: () => { throw new Error("bootstrap create"); } });
    try {
      assert.equal(await automaticConsume(occurrence, alice, [alice], now), "state-unavailable");
      assert.deepEqual(await sharedClose(occurrence, true, now), unavailableShared);
    } finally { createRestore(); }

    mkdirSync(sidecar);
    try {
      assert.equal(await directConsume(occurrence, alice, null, [alice], now), "state-unavailable");
      assert.deepEqual(await sharedClose(occurrence, true, now), unavailableShared);
      assert.ok(lstatSync(sidecar).isDirectory(), "an unreplaceable directory remains a directory");
    } finally { rmSync(sidecar, { recursive: true }); }
  } finally { done(); }
});

test("partial bootstrap and replacement writes clean their own temporary inode", async () => {
  const { dir, done } = isolated("partial-temporaries");
  try {
    const sidecar = join(dir, "morning-handoff.json");
    for (const phase of ["bootstrap", "replacement"] as const) {
      if (phase === "replacement") assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "open", consumed: [] });
      const temporary = `${sidecar}.${phase}.tmp`;
      const restore = setMorningHandoffStoreTestSeam({
        temporaryPath: () => temporary,
        writeSync: ((fd: number, data: Uint8Array, offset = 0, length = data.byteLength - offset, position: number | null = null) => { writeSync(fd, data, offset, Math.min(length, 1), position); throw new Error("simulated ENOSPC"); }) as unknown as typeof writeSync,
      });
      try {
        const result = phase === "bootstrap" ? await inspectMorningHandoff(occurrence, now) : await directConsume(occurrence, alice, null, [alice], now);
        assert.equal(phase === "bootstrap" ? (result as { state: string }).state : result, "state-unavailable");
      } finally {
        restore();
        assert.equal(lstatSync(temporary, { throwIfNoEntry: false }), undefined, `${phase} partial temporary is cleaned`);
      }
    }
    const collision = `${sidecar}.collision-after-create.tmp`;
    writeFileSync(collision, "pre-existing", { mode: 0o600 });
    const restore = setMorningHandoffStoreTestSeam({ temporaryPath: () => collision });
    try { assert.equal(await directConsume(occurrence, alice, null, [alice], now), "state-unavailable"); }
    finally { restore(); assert.equal(readFileSync(collision, "utf8"), "pre-existing"); }
  } finally { done(); }
});

test("descriptor open uses nofollow nonblocking read flags and closes a FIFO swapped at open", async () => {
  const { dir, done } = isolated("open-flags");
  try {
    const sidecar = join(dir, "morning-handoff.json");
    writeFileSync(sidecar, '{"version":1,"occurrences":{}}', { mode: 0o600 });
    let opened: number | undefined;
    let closed: number | undefined;
    const restore = setMorningHandoffStoreTestSeam({
      openSync: ((path, flags, mode) => {
        if (path === sidecar && flags === (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)) {
          rmSync(sidecar); execFileSync("mkfifo", [sidecar]);
          opened = openSync(path, flags, mode);
          return opened;
        }
        return openSync(path, flags, mode);
      }) as typeof openSync,
      closeSync: ((fd: number) => { closed = fd; return closeSync(fd); }) as typeof closeSync,
    });
    try { assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" }); }
    finally { restore(); rmSync(sidecar, { force: true }); }
    assert.equal(closed, opened, "FIFO descriptor is closed after fstat rejects it");
  } finally { done(); }
});

test("descriptor-bound reads reject FIFO, path swaps, post-open cumulative overflow, and closed descriptors", async () => {
  const { dir, done } = isolated("descriptor-attacks");
  try {
    const sidecar = join(dir, "morning-handoff.json");
    execFileSync("mkfifo", [sidecar]);
    assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" });
    rmSync(sidecar);
    writeFileSync(sidecar, '{"version":1,"occurrences":{}}', { mode: 0o600 });
    const alternate = join(dir, "alternate"); writeFileSync(alternate, '{"version":1,"occurrences":{}}', { mode: 0o600 });
    let lstatCalls = 0;
    let restore = setMorningHandoffStoreTestSeam({ lstatSync: ((path: Parameters<typeof lstatSync>[0]) => {
      if (path === sidecar && ++lstatCalls === 2) renameSync(alternate, sidecar);
      return lstatSync(path);
    }) as typeof lstatSync });
    try { assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" }); } finally { restore(); }
    // A swap to FIFO after the regular descriptor opens is rejected by the post-open path fence.
    writeFileSync(sidecar, '{"version":1,"occurrences":{}}', { mode: 0o600 });
    lstatCalls = 0;
    restore = setMorningHandoffStoreTestSeam({ lstatSync: ((path: Parameters<typeof lstatSync>[0]) => {
      if (path === sidecar && ++lstatCalls === 2) { rmSync(sidecar); execFileSync("mkfifo", [sidecar]); }
      return lstatSync(path);
    }) as typeof lstatSync });
    try { assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" }); } finally { restore(); rmSync(sidecar); }
    // A pre-open pathname swap to a symlink is not followed.
    writeFileSync(sidecar, '{"version":1,"occurrences":{}}', { mode: 0o600 });
    restore = setMorningHandoffStoreTestSeam({ lstatSync: ((path: Parameters<typeof lstatSync>[0]) => {
      if (path === sidecar) { rmSync(sidecar); symlinkSync(alternate, sidecar); }
      return lstatSync(path);
    }) as typeof lstatSync });
    try { assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" }); } finally { restore(); rmSync(sidecar); }
    writeFileSync(sidecar, '{"version":1,"occurrences":{}}', { mode: 0o600 });
    let grew = false;
    restore = setMorningHandoffStoreTestSeam({ readSync: ((fd, buffer, offset, length, position) => {
      const result = readSync(fd, buffer, offset, length, position);
      if (!grew) { grew = true; appendFileSync(sidecar, "x".repeat(64 * 1024 + 1)); }
      return result;
    }) as typeof readSync });
    try { assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" }); } finally { restore(); }
    // This changes metadata after the descriptor's post-read fstat but before
    // the final pathname stat; same inode and valid bytes must still be rejected.
    writeFileSync(sidecar, '{"version":1,"occurrences":{}}', { mode: 0o600 });
    let postRead = false;
    let fstatCalls = 0;
    lstatCalls = 0;
    restore = setMorningHandoffStoreTestSeam({
      fstatSync: ((fd: number) => { const result = statSync(`/proc/self/fd/${fd}`); postRead = ++fstatCalls === 2; return result; }) as typeof fstatSync,
      lstatSync: ((path: Parameters<typeof lstatSync>[0]) => {
        if (path === sidecar && postRead && ++lstatCalls === 1) utimesSync(sidecar, new Date("2026-08-24T00:00:00.000Z"), new Date("2026-08-24T00:00:00.000Z"));
        return lstatSync(path);
      }) as typeof lstatSync,
    });
    try { assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" }); } finally { restore(); }
    writeFileSync(sidecar, '{"version":1,"occurrences":{}}', { mode: 0o600 });
    restore = setMorningHandoffStoreTestSeam({ fstatSync: ((fd: number) => { closeSync(fd); throw new Error("closed"); }) as never });
    try { assert.deepEqual(await inspectMorningHandoff(occurrence, now), { state: "state-unavailable" }); } finally { restore(); }
  } finally { done(); }
});

test("overflow replacement is exactly current-only for direct and automatic mutations", async () => {
  const { dir, done } = isolated("current-only-overflow");
  try {
    const sidecar = join(dir, "morning-handoff.json");
    const old = "2026-08-22T08:00:00.000Z";
    const seed = () => writeFileSync(sidecar, JSON.stringify({ version: 1, occurrences: { [old]: { closed: false, consumed: [], updated_at: now.toISOString() } } }), { mode: 0o600 });
    const aliases = Array.from({ length: 257 }, (_, n) => `a${n}@example.com`);
    seed(); assert.equal(await directConsume(occurrence, { emails: aliases, phones: [] }, null, [], now), "state-unavailable");
    assert.deepEqual(JSON.parse(readFileSync(sidecar, "utf8")).occurrences, { [occurrence]: { closed: true, consumed: [], updated_at: now.toISOString() } });
    seed(); assert.equal(await automaticConsume(occurrence, { emails: aliases, phones: [] }, [], now), "state-unavailable");
    assert.deepEqual(JSON.parse(readFileSync(sidecar, "utf8")).occurrences, { [occurrence]: { closed: true, consumed: [], updated_at: now.toISOString() } });
  } finally { done(); }
});

function child(code: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const childProcess = spawn(process.execPath, ["--input-type=module", "--eval", code], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    childProcess.stdout.on("data", data => { stdout += data; }); childProcess.stderr.on("data", data => { stderr += data; });
    childProcess.on("error", reject); childProcess.on("exit", status => status === 0 ? resolveResult(stdout.trim()) : reject(new Error(stderr || `child ${status}`)));
  });
}

test("independent first-use bootstrap is locked before publication and preserves complete winner tokens", async () => {
  const { dir, done } = isolated("process-bootstrap");
  try {
    const creatorLocked = join(dir, "creator-locked"), releaseCreator = join(dir, "release-creator");
    const observerAttempted = join(dir, "observer-attempted"), observerAcquired = join(dir, "observer-acquired");
    const sidecar = join(dir, "morning-handoff.json");
    const moduleUrl = new URL("./morning-handoff-store.ts", import.meta.url).href;
    const common = `const m=await import(${JSON.stringify(moduleUrl)}); const o=${JSON.stringify(occurrence)}; const n=new Date(${JSON.stringify(now.toISOString())}); const a={emails:['alice@example.com'],phones:['+15551234567']}; const b={emails:['bob@example.com'],phones:['+15557654321']};`;
    const waitFor = async (path: string) => {
      for (let attempts = 0; !existsSync(path) && attempts < 400; attempts++) await new Promise(resolveWait => setTimeout(resolveWait, 5));
      assert.ok(existsSync(path), `expected gate ${path}`);
    };
    // Creator pauses after acquiring the production lock and before bootstrap.
    const creator = child(`import {writeFileSync,existsSync} from 'node:fs'; import lockfile from 'proper-lockfile'; ${common} m.setMorningHandoffStoreTestSeam({lock:async path=>{const release=await lockfile.lock(path,{realpath:false,stale:10000,retries:{retries:30,minTimeout:30,maxTimeout:300}}); writeFileSync(process.env.CREATOR_LOCKED,'locked'); while(!existsSync(process.env.RELEASE_CREATOR)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); return release;}}); console.log(await m.directConsume(o,a,null,[a,b],n));`, { SCHEDULE_DIR_OVERRIDE: dir, CREATOR_LOCKED: creatorLocked, RELEASE_CREATOR: releaseCreator });
    await waitFor(creatorLocked);
    assert.equal(existsSync(sidecar), false, "no sidecar pathname is published before locked bootstrap");
    // Observer marks its lock attempt before awaiting the same production lock,
    // and can mark acquisition only after the creator releases it.
    const observer = child(`import {writeFileSync} from 'node:fs'; import lockfile from 'proper-lockfile'; ${common} m.setMorningHandoffStoreTestSeam({lock:async path=>{writeFileSync(process.env.OBSERVER_ATTEMPTED,'attempted'); const release=await lockfile.lock(path,{realpath:false,stale:10000,retries:{retries:30,minTimeout:30,maxTimeout:300}}); writeFileSync(process.env.OBSERVER_ACQUIRED,'acquired'); return release;}}); console.log(await m.directConsume(o,b,null,[a,b],n));`, { SCHEDULE_DIR_OVERRIDE: dir, OBSERVER_ATTEMPTED: observerAttempted, OBSERVER_ACQUIRED: observerAcquired });
    await waitFor(observerAttempted);
    assert.equal(existsSync(observerAcquired), false, "observer cannot acquire before creator releases");
    writeFileSync(releaseCreator, "go");
    assert.equal(await creator, "direct-consumed");
    assert.equal(await observer, "direct-consumed");
    const saved = JSON.parse(readFileSync(sidecar, "utf8"));
    assert.deepEqual(saved.occurrences[occurrence].consumed, [...[...alice.emails, ...alice.phones, ...bob.emails, ...bob.phones].map(addressToken)].sort());
    assert.equal(saved.occurrences[occurrence].closed, true);
  } finally { done(); }
});

test("retention preserves an older current occurrence and repeatedly prunes newer byte pressure", async () => {
  const { dir, done } = isolated("cumulative-prune");
  try {
    const sidecar = join(dir, "morning-handoff.json");
    const current = "2026-08-01T08:00:00.000Z";
    const entries: Record<string, unknown> = {};
    for (let day = 2; day <= 9; day++) entries[new Date(Date.UTC(2026, 7, day, 8)).toISOString()] = { closed: false, consumed: [], updated_at: now.toISOString() };
    writeFileSync(sidecar, JSON.stringify({ version: 1, occurrences: entries }), { mode: 0o600 });
    assert.equal(await directConsume(current, alice, null, [alice, bob], now), "direct-consumed");
    const saved = JSON.parse(readFileSync(sidecar, "utf8")).occurrences;
    assert.ok(saved[current]); assert.equal(Object.keys(saved).length, 8); assert.equal(saved["2026-08-02T08:00:00.000Z"], undefined);
  } finally { done(); }
});
