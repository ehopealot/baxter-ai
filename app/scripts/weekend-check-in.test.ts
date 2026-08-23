import { test } from "node:test";
import assert from "node:assert/strict";
import { selectWeekendEvents } from "./weekend-check-in.ts";
import type { StoredEvent } from "./calendar-store.ts";

const options = { now: new Date("2026-08-21T16:00:00Z"), tz: "America/Los_Angeles", familyEligible: true };
const own = (over: Partial<StoredEvent>): StoredEvent => ({ uid: "own", title: "Weekend", start: "2026-08-22T20:00:00Z", created: "", updated: "", ...over });

test("weekend selection applies the shared exact calendar schema", () => {
  const invalid = [
    own({ start: "2026-02-30", allDay: true }),
    own({ start: "2026-08-22", allDay: false }),
    own({ start: "2026-08-22", end: "2026-08-23T00:00:00Z", allDay: true }),
    own({ start: "2026-08-22T20:00:00Z", end: "2026-08-22" }),
    own({ start: "2026-08-22T20:00:00Z", end: "2026-08-22T19:00:00Z" }),
  ];
  for (const event of invalid) assert.deepEqual(selectWeekendEvents([event], [], options), []);
  assert.deepEqual(selectWeekendEvents([], [{ uid: "bad", title: "Bad", location: null, startMs: 2, endMs: 1, allDay: false, rrule: null, url: null }], options), []);
});
