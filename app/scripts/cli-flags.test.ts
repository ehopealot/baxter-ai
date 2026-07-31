// Tests for the shared CLI arg parser (cli-flags.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlags } from "./cli-flags.ts";

test("parseFlags: --key value, --key=value, positionals", () => {
  const { flags, positionals } = parseFlags(["show", "g", "--channel", "123", "--due=2026-08-01"]);
  assert.deepEqual(positionals, ["show", "g"]);
  assert.equal(flags.channel, "123");
  assert.equal(flags.due, "2026-08-01");
});

test("parseFlags: a valueless flag doesn't swallow the following positional", () => {
  // Without boolFlags, --open greedily takes "g" as its value (the old wart).
  assert.equal(parseFlags(["show", "--open", "g"]).flags.open, "g");
  // Named as valueless, it's a true boolean and "g" stays a positional.
  const named = parseFlags(["show", "--open", "g"], new Set(["open"]));
  assert.equal(named.flags.open, true);
  assert.deepEqual(named.positionals, ["show", "g"]);
});

test("parseFlags: a bare boolean flag at end is true even without boolFlags", () => {
  assert.equal(parseFlags(["show", "g", "--open"]).flags.open, true);
});

test("parseFlags: --key= is the escape hatch for a dash-leading value", () => {
  assert.equal(parseFlags(["--start=-1"]).flags.start, "-1");
});
