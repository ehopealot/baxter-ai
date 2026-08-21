import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCalendarFeeds, writeCalendarFeeds } from "./calendar-feeds.ts";

const p = () => join(mkdtempSync(join(tmpdir(), "feeds-")), "feeds.json");

test("missing file -> empty, version 0", () => {
  assert.deepEqual(loadCalendarFeeds(join(mkdtempSync(join(tmpdir(), "feeds-")), "nope.json")), { urls: [], version: 0 });
});

test("write then read round-trips; file is 0600", () => {
  const path = p();
  writeCalendarFeeds({ urls: ["https://a", "https://b"], version: 3 }, path);
  assert.deepEqual(loadCalendarFeeds(path), { urls: ["https://a", "https://b"], version: 3 });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("corrupt JSON and bad shape -> empty, version 0", () => {
  const path = p();
  writeFileSync(path, "{ not json");
  assert.deepEqual(loadCalendarFeeds(path), { urls: [], version: 0 });
  writeFileSync(path, JSON.stringify({ urls: "x", version: 1 }));
  assert.deepEqual(loadCalendarFeeds(path), { urls: [], version: 0 });
});

test("absurd version -> 0; non-string urls filtered", () => {
  const path = p();
  writeFileSync(path, JSON.stringify({ urls: ["https://a", 7, null], version: -1 }));
  assert.deepEqual(loadCalendarFeeds(path), { urls: ["https://a"], version: 0 });
});

test("an injected diagnostic sink emits fixed categories without secret paths, URLs, parser messages, or console output", () => {
  const root = mkdtempSync(join(tmpdir(), "feeds-secret-"));
  const corrupt = join(root, "https-secret-feed-token.json");
  writeFileSync(corrupt, "{ parser secret https://calendar.example/private.ics");
  const categories: string[] = [];
  const errSpy = mock.method(console, "error", () => {});
  try {
    assert.deepEqual(loadCalendarFeeds(corrupt, (diagnostic) => categories.push(diagnostic.category)), { urls: [], version: 0 });
    const unreadable = join(root, "unreadable-feed-file");
    mkdirSync(unreadable);
    assert.deepEqual(loadCalendarFeeds(unreadable, (diagnostic) => categories.push(diagnostic.category)), { urls: [], version: 0 });
    assert.deepEqual(categories, ["corrupt-json", "unreadable"]);
    assert.equal(errSpy.mock.calls.length, 0);
    assert.doesNotMatch(categories.join(" "), /secret|https:|private|parser|feeds-secret/);
  } finally {
    errSpy.mock.restore();
  }
});
