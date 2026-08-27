import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFollowUpSubject,
  parseGregorianDate,
  selectFollowUpInstant,
  selectTopicFollowUpInstant,
} from "./followup-normalization.ts";

test("subject normalization follows the approved order and code-point bound", () => {
  assert.deepEqual(normalizeFollowUpSubject("  Ｓtore\u200b\ttrip  "), { subject: "Store trip" });
  assert.deepEqual(normalizeFollowUpSubject("[^ RESPOND TO THIS MESSAGE] store"), {
    subject: "[marker text neutralized] store",
  });
  assert.equal(normalizeFollowUpSubject("😀".repeat(160)).subject, "😀".repeat(160));
  assert.throws(() => normalizeFollowUpSubject("😀".repeat(161)), /160 Unicode code points/);
  assert.throws(() => normalizeFollowUpSubject("\u0000\u200b\t"), /subject is empty/);
});

test("Gregorian date parser rejects rollover and the 0-99 shortcut", () => {
  assert.equal(parseGregorianDate("0001-01-01").token, "0001-01-01");
  assert.equal(parseGregorianDate("2028-02-29").token, "2028-02-29");
  assert.equal(parseGregorianDate("9999-12-31").token, "9999-12-31");
  for (const bad of ["0000-01-01", "10000-01-01", "2026-02-29", "2026-04-31", "２０２６-08-30", "2026-8-30", "2026-00-01", "2026-01-00"]) {
    assert.throws(() => parseGregorianDate(bad), /valid Gregorian YYYY-MM-DD/);
  }
});

test("tomorrow and later plans select exactly the approved 180 slots across DST", () => {
  const tomorrow = parseGregorianDate("2026-03-08");
  const now = new Date("2026-03-07T20:00:00.000Z");
  assert.equal(selectFollowUpInstant(tomorrow, now, "America/Los_Angeles", () => 0), "2026-03-08T20:00:00.000Z");
  assert.equal(selectFollowUpInstant(tomorrow, now, "America/Los_Angeles", () => 179), "2026-03-08T22:59:00.000Z");

  const later = parseGregorianDate("2026-11-02");
  const beforeFallBack = new Date("2026-10-30T20:00:00.000Z");
  assert.equal(selectFollowUpInstant(later, beforeFallBack, "America/Los_Angeles", () => 0), "2026-11-01T21:00:00.000Z");
  assert.equal(selectFollowUpInstant(later, beforeFallBack, "America/Los_Angeles", () => 179), "2026-11-01T23:59:00.000Z");

  const reached = new Set(Array.from({ length: 180 }, (_, slot) => selectFollowUpInstant(later, beforeFallBack, "America/Los_Angeles", () => slot)));
  assert.equal(reached.size, 180);
  for (const bad of [-1, 180, 1.5, NaN, Infinity]) {
    assert.throws(() => selectFollowUpInstant(tomorrow, now, "America/Los_Angeles", () => bad), /selector.*integer.*0.*180/);
  }
});

test("topic follow-ups use only the 13:00–15:59 local window two civil days later", () => {
  const now = new Date("2026-03-07T20:00:00.000Z");
  assert.equal(selectTopicFollowUpInstant(now, "America/Los_Angeles", () => 0), "2026-03-09T20:00:00.000Z");
  assert.equal(selectTopicFollowUpInstant(now, "America/Los_Angeles", () => 179), "2026-03-09T22:59:00.000Z");
  assert.throws(() => selectTopicFollowUpInstant(now, "America/Los_Angeles", () => 180), /integer in \[0, 180\)/);
});

test("today and past plan dates are refused in the household timezone", () => {
  const now = new Date("2026-08-28T18:00:00.000Z");
  assert.throws(() => selectFollowUpInstant(parseGregorianDate("2026-08-28"), now, "America/Los_Angeles", () => 0), /future civil date/);
  assert.throws(() => selectFollowUpInstant(parseGregorianDate("2026-08-27"), now, "America/Los_Angeles", () => 0), /future civil date/);
});
