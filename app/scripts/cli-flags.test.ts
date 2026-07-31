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

test("parseFlags: --boolFlag=true/false coerces to a real boolean (not the string 'true')", () => {
  const b = new Set(["open"]);
  assert.equal(parseFlags(["--open=true"], b).flags.open, true);   // not "true", which === true reads as unset
  assert.equal(parseFlags(["--open=false"], b).flags.open, false); // explicit off
  // a non-bool key with `=value` still stores the string
  assert.equal(parseFlags(["--channel=123"], b).flags.channel, "123");
});

test("parseFlags: bare -- ends flags; everything after is a positional", () => {
  const { flags, positionals } = parseFlags(["remove", "--", "--weird-uid"]);
  assert.deepEqual(positionals, ["remove", "--weird-uid"]); // the uid survives, not lost to flags[""]
  assert.equal(flags[""], undefined);
});
