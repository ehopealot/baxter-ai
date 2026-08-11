// Tests for the own-event store: add/remove/read round-trips + the cross-process
// mutate lock (the load-bearing guarantee -- an unlocked read-modify-write would
// lose an add when two surfaces race). Mirrors send-state.test's cross-process style.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { addEvent, removeEvent, readEvents, newUid } from "./calendar-store.ts";

const storePath = (): string => join(mkdtempSync(join(tmpdir(), "cal-")), "events.json");

test("addEvent appends with a fresh uid + timestamps; readEvents round-trips", async () => {
  const p = storePath();
  const a = await addEvent(p, { title: "Dentist", start: "2026-08-04T15:00:00Z", location: "Main St" });
  assert.match(a.uid, /@baxter$/);
  assert.equal(a.title, "Dentist");
  assert.equal(a.location, "Main St");
  assert.ok(a.created && a.updated);
  const all = readEvents(p);
  assert.equal(all.length, 1);
  assert.equal(all[0].uid, a.uid);
});

test("readEvents on a missing store is [] (not a throw)", () => {
  assert.deepEqual(readEvents(join(tmpdir(), "definitely-missing-cal-store-xyz.json")), []);
});

test("removeEvent removes by uid and reports whether it did", async () => {
  const p = storePath();
  const a = await addEvent(p, { title: "X", start: "2026-08-04", allDay: true });
  assert.equal(await removeEvent(p, a.uid), true);
  assert.equal(readEvents(p).length, 0);
  assert.equal(await removeEvent(p, "missing@baxter"), false);
});

test("a no-match removeEvent leaves the store file untouched (mutate skips the tmp+rename)", async () => {
  const p = storePath();
  await addEvent(p, { title: "X", start: "2026-08-04", allDay: true });
  const before = statSync(p);
  assert.equal(await removeEvent(p, "missing@baxter"), false);
  const after = statSync(p);
  // A rewrite is a tmp+rename, which swaps the inode -- so an unchanged inode proves no write.
  assert.equal(after.ino, before.ino, "no rename: the no-match delete did not rewrite the store");
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("newUid is unique and shaped", () => {
  const a = newUid();
  const b = newUid();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{24}@baxter$/);
});

test("concurrent addEvent across processes never loses an event (the lock holds)", async () => {
  const p = storePath();
  const modUrl = new URL("./calendar-store.ts", import.meta.url).href;
  const N = 8;
  const child = (i: number): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ["-e", `import(${JSON.stringify(modUrl)}).then((m) => m.addEvent(${JSON.stringify(p)}, {title:"E${i}", start:"2026-08-04T12:00:00Z"})).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })`],
        {},
        (err) => (err ? reject(err) : resolve()),
      );
    });
  await Promise.all(Array.from({ length: N }, (_, i) => child(i)));
  const titles = readEvents(p).map((e) => e.title).sort();
  assert.deepEqual(titles, Array.from({ length: N }, (_, i) => `E${i}`).sort(), "every concurrent add survived");
});
