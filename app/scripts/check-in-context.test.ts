import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRecipientContexts,
  cleanCalendarField,
  cleanPromptName,
  isValidDailyBody,
  isWellFormedString,
  parseWeeklyCopy,
  personalizeDailyBody,
} from "./check-in-context.ts";
import type { ResolvedContact } from "./recipients.ts";

const contacts: ResolvedContact[] = [
  { name: "  Erik\u0000\u001b\u0085\u2028 Hope\ud800  ", phones: ["+15550000001"], emails: ["erik@example.com"] },
  { name: "Laura", phones: [], emails: ["laura@example.com"] },
  { name: "Laura", phones: [], emails: ["laura2@example.com"] },
  { name: "\udc00", phones: [], emails: ["unnamed@example.com"] },
];

test("canonical prompt names repair malformed UTF-16 first, remove controls, single-line, and cap by code point", () => {
  assert.equal(cleanPromptName(contacts[0]!.name), "Erik     Hope�");
  assert.equal(cleanPromptName(contacts[3]!.name), "�");
  assert.equal(cleanPromptName("\u0000\u001b\u0085\u2029"), null);
  assert.equal([...cleanPromptName("😀".repeat(90))!].length, 80);
  assert.ok(isWellFormedString(cleanPromptName("😀".repeat(90))!));
});

test("recipient context is ordered, bounded to 20 other names, retains duplicates, and structurally omits routing fields", () => {
  const many: ResolvedContact[] = Array.from({ length: 24 }, (_, index) => ({
    name: index === 22 ? undefined : index < 3 ? "Same" : `Person ${index}`,
    phones: [`+1555${index}`], emails: [`p${index}@example.com`],
  }));
  const contexts = buildRecipientContexts(many);
  assert.equal(contexts[0]!.otherNamedHouseholdMembers.length, 20);
  assert.deepEqual(contexts[0]!.otherNamedHouseholdMembers.slice(0, 2), ["Same", "Same"]);
  assert.equal(contexts[0]!.omittedOtherNamedRecipientCount, 2);
  assert.ok(!JSON.stringify(contexts).includes("@example.com"));
  assert.ok(!JSON.stringify(contexts).includes("+1555"));
  assert.equal("ambiguous" in contexts[0]!, false);
  assert.equal("unique" in contexts[0]!, false);
});

test("calendar fields repair lone surrogates and controls before whitespace cleaning and surrogate-safe code-unit caps", () => {
  const cleaned = cleanCalendarField(`A\ud800\u0085  B ${"😀".repeat(110)}`, 200);
  assert.ok(isWellFormedString(cleaned));
  assert.doesNotMatch(cleaned, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
  assert.ok(cleaned.length <= 200);
});

test("generated output rejects malformed UTF-16, controls, Markdown headings and fences, markup, and salutations including household names", () => {
  const names = ["Laura", "Erik Hope"];
  for (const body of [
    "\ud800", "\udc00", "Hello everyone", "Hi there", "Hey folks", "Dear Laura", "Good morning, Laura", "Laura, here is today",
    "Laura – here is today", "Laura — here is today", "Good morning – Laura, here is today", "Good morning — Laura, here is today",
    "Good morning – Laura", "Good morning – Laura.", "Good morning — Laura", "Good morning — Laura.",
    "Good afternoon – Laura", "Good afternoon – Laura.", "Good afternoon — Laura", "Good afternoon — Laura.",
    "Good evening – Laura", "Good evening – Laura.", "Good evening — Laura", "Good evening — Laura.",
    "<b>hi</b>", "bad\u0085text", "```text\nprivate\n```", "~~~text\nprivate\n~~~", "Private heading\n===", "Private heading\n---",
    "Agenda\n# Heading\nDetails", "Agenda\n # Heading\nDetails", "Agenda\n  ###### Heading\nDetails", "Agenda\n   ###\nDetails",
  ]) {
    assert.equal(isValidDailyBody(body, names), null, JSON.stringify(body));
    assert.equal(parseWeeklyCopy(JSON.stringify({ subject: "A gentle update", body }), names, () => true), null, JSON.stringify(body));
  }
  assert.equal(isValidDailyBody("- ordinary list line\n• another ordinary list line", names), "- ordinary list line\n• another ordinary list line");
  assert.deepEqual(
    parseWeeklyCopy(JSON.stringify({ subject: "A gentle update", body: "- ordinary list line\n• another ordinary list line" }), names, () => true),
    { subject: "A gentle update", body: "- ordinary list line\n• another ordinary list line" },
  );
  assert.equal(isValidDailyBody("Good morning — here’s your Tuesday calendar", names), "Good morning — here’s your Tuesday calendar");
  assert.equal(isValidDailyBody("Good morning — Lauralee has the details", names), "Good morning — Lauralee has the details");
  assert.deepEqual(
    parseWeeklyCopy(JSON.stringify({ subject: "A gentle update", body: "Good morning — here’s your Tuesday calendar" }), names, () => true),
    { subject: "A gentle update", body: "Good morning — here’s your Tuesday calendar" },
  );
  assert.equal(parseWeeklyCopy(JSON.stringify({ subject: "LAURA update", body: "A useful note." }), names, () => true), null);
  const overflowNames = Array.from({ length: 22 }, (_, index) => `Person ${index}`);
  assert.equal(parseWeeklyCopy(JSON.stringify({ subject: "ＰＥＲＳＯＮ 21 update", body: "A useful note." }), overflowNames, () => true), null, "NFKC name validation includes names beyond the 20-name prompt cap");
  assert.equal(parseWeeklyCopy(JSON.stringify({ subject: "A gentle update", body: "A useful note." }), names, () => true)?.subject, "A gentle update");
  for (const raw of [
    '{"subject":"\\ud800","body":"fine"}',
    '{"subject":"\\udc00","body":"fine"}',
    '{"subject":"ok","body":"\\ud800"}',
    '{"subject":"ok","body":"\\udc00"}',
  ]) assert.equal(parseWeeklyCopy(raw, names, () => true), null, raw);
  assert.equal(parseWeeklyCopy(JSON.stringify({ subject: "ok", body: "fine", extra: "no" }), names, () => true), null);
});

test("daily personalization preserves the complete greeting and never splits a surrogate pair", () => {
  const value = personalizeDailyBody("A".repeat(1985) + " 😀 tail", "Very Long Name");
  assert.ok(value.startsWith("Hi Very Long Name — "));
  assert.ok(value.length <= 2000);
  assert.ok(isWellFormedString(value));
  assert.ok(value.endsWith("…"));
});
