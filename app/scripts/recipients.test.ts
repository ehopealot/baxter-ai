import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRecipients } from "./recipients.ts";
import type { Allowlist } from "./allowlist.ts";

function roster(over: Partial<Allowlist>): Allowlist {
  return { senders: [], recipients: [], version: 1, names: {}, ...over };
}
const noEnv: NodeJS.ProcessEnv = {};
function env(over: Record<string, string>): NodeJS.ProcessEnv { return { ...over }; }

test("duplicate-entry canonical dedup: one address listed twice (case-variant) under one name resolves to ONE contact carrying phone and email, unresolvedPhones empty", () => {
  // The round-4 fixture: without pre-grouping dedup the duplicated raw entry would
  // masquerade as a two-emails-one-name collision, minting two email-only contacts
  // and stranding the same-name phone in unresolvedPhones.
  const list = roster({
    senders: ["+15550001111"],
    recipients: ["Dana@X.com", "dana@x.com"],
    names: { "dana@x.com": "Dana Lee", "+15550001111": "Dana Lee" },
  });
  const r = resolveRecipients(list, noEnv);
  assert.deepEqual(r.contacts, [{ name: "Dana Lee", phones: ["+15550001111"], emails: ["dana@x.com"] }]);
  assert.deepEqual(r.unresolvedPhones, []);
  assert.equal(r.unpairedOperatorPair, false);
});

test("two DISTINCT addresses sharing a cleaned name stay a duplicate-nickname collision: independent email-only contacts, phones unresolved", () => {
  const list = roster({
    senders: ["+15550002222"],
    recipients: ["alex1@x.com", "alex2@x.com"],
    names: { "alex1@x.com": "Alex Kim", "alex2@x.com": "Alex Kim", "+15550002222": "Alex Kim" },
  });
  const r = resolveRecipients(list, noEnv);
  assert.deepEqual(r.contacts, [
    { name: "Alex Kim", phones: [], emails: ["alex1@x.com"] },
    { name: "Alex Kim", phones: [], emails: ["alex2@x.com"] },
  ]);
  assert.deepEqual(r.unresolvedPhones, ["+15550002222"]);
});

test("a cleaned name held by exactly one recipient email pairs every same-name phone (senders or recipients) with it into one contact", () => {
  const list = roster({
    senders: ["+15550004444"],
    recipients: ["sam@x.com", "+15550003333"],
    names: { "sam@x.com": "Sam Ray", "+15550003333": "Sam Ray", "+15550004444": "Sam Ray" },
  });
  const r = resolveRecipients(list, noEnv);
  assert.deepEqual(r.contacts, [
    { name: "Sam Ray", phones: ["+15550003333", "+15550004444"], emails: ["sam@x.com"] },
  ]);
  assert.deepEqual(r.unresolvedPhones, []);
});

test("the operator pair forms only while BOTH OPERATOR_PHONE and OPERATOR_EMAIL are currently admitted", () => {
  const list = roster({ senders: ["+15550005555"] });
  const both = resolveRecipients(list, env({ OPERATOR_PHONE: "+15550005555", OPERATOR_EMAIL: "boss@x.com" }));
  assert.deepEqual(both.contacts, [{ phones: ["+15550005555"], emails: ["boss@x.com"] }]);

  // Dropping the env email: the pair is not inferred. The phone alone stays an unnamed
  // admitted phone -> legacy phone-only contact; no contact carries the operator email.
  const noEmail = resolveRecipients(list, env({ OPERATOR_PHONE: "+15550005555" }));
  assert.deepEqual(noEmail.contacts, [{ phones: ["+15550005555"], emails: [] }]);

  // Dropping the env phone: the pair is not inferred. The roster phone alone stays an
  // unnamed admitted phone -> legacy phone-only contact; no contact carries the
  // operator email (the env-only email is never resolved on its own).
  const noPhone = resolveRecipients(list, env({ OPERATOR_EMAIL: "boss@x.com" }));
  assert.equal(noPhone.contacts.filter((c) => c.emails.includes("boss@x.com")).length, 0);
  assert.deepEqual(noPhone.contacts, [{ phones: ["+15550005555"], emails: [] }]);

  // Env phone not on the roster (senders ∪ recipients): the strict phone-admission
  // check (mirroring sendSms's admittedRecipient) fails -> no operator contact.
  const offRoster = resolveRecipients(roster({}), env({ OPERATOR_PHONE: "+15550005555", OPERATOR_EMAIL: "boss@x.com" }));
  assert.deepEqual(offRoster.contacts, []);

  // Malformed env values never admit the pair either.
  const malformed = resolveRecipients(roster({ senders: ["+15550005555"] }), env({ OPERATOR_PHONE: "555-0001", OPERATOR_EMAIL: "not an email" }));
  assert.deepEqual(malformed.contacts, [{ phones: ["+15550005555"], emails: [] }]);
});

test("operator merge: an operator email already in exactly one resolved named contact absorbs the operator phone (no second contact minted)", () => {
  const list = roster({
    senders: ["+15550006666"],
    recipients: ["op@x.com"],
    names: { "op@x.com": "Erik Hope" },
  });
  const r = resolveRecipients(list, env({ OPERATOR_PHONE: "+15550006666", OPERATOR_EMAIL: "op@x.com" }));
  assert.deepEqual(r.contacts, [{ name: "Erik Hope", phones: ["+15550006666"], emails: ["op@x.com"] }]);
  assert.equal(r.unpairedOperatorPair, false);
});

test("operator merge: an operator phone already paired into a resolved named contact gains the operator email as a candidate of THAT contact", () => {
  const list = roster({
    senders: ["+15550007777"],
    recipients: ["pia@x.com"],
    names: { "pia@x.com": "Pia Noel", "+15550007777": "Pia Noel" },
  });
  const r = resolveRecipients(list, env({ OPERATOR_PHONE: "+15550007777", OPERATOR_EMAIL: "pianoel@x.com" }));
  assert.deepEqual(r.contacts, [
    { name: "Pia Noel", phones: ["+15550007777"], emails: ["pia@x.com", "pianoel@x.com"] },
  ]);
});

test("operator pair across TWO different resolved contacts: no merge in either direction, exactly the two original contacts, unpairedOperatorPair flagged", () => {
  const list = roster({
    senders: ["+15550008888"],
    recipients: ["op@x.com", "other@x.com"],
    names: { "op@x.com": "Erik Hope", "other@x.com": "Pia Noel", "+15550008888": "Pia Noel" },
  });
  const r = resolveRecipients(list, env({ OPERATOR_PHONE: "+15550008888", OPERATOR_EMAIL: "op@x.com" }));
  // The email's contact gains no phones from the pair; the phone's contact gains no emails.
  assert.deepEqual(r.contacts, [
    { name: "Erik Hope", phones: [], emails: ["op@x.com"] },
    { name: "Pia Noel", phones: ["+15550008888"], emails: ["other@x.com"] },
  ]);
  assert.equal(r.unpairedOperatorPair, true);
});

test("operator pair already inside ONE resolved contact is a no-op with no flag", () => {
  const list = roster({
    senders: ["+15550009999"],
    recipients: ["op@x.com"],
    names: { "op@x.com": "Erik Hope", "+15550009999": "Erik Hope" },
  });
  const r = resolveRecipients(list, env({ OPERATOR_PHONE: "+15550009999", OPERATOR_EMAIL: "op@x.com" }));
  assert.deepEqual(r.contacts, [{ name: "Erik Hope", phones: ["+15550009999"], emails: ["op@x.com"] }]);
  assert.equal(r.unpairedOperatorPair, false);
});

test("unnamed admitted email and phone become legacy email-only / phone-only contacts", () => {
  const list = roster({ senders: ["+15550001234"], recipients: ["anon@x.com"] });
  const r = resolveRecipients(list, noEnv);
  assert.deepEqual(r.contacts, [
    { phones: ["+15550001234"], emails: [] },
    { phones: [], emails: ["anon@x.com"] },
  ]);
});

test("canonical dedupe and deterministic ordering: duplicated entries collapse, contacts sort name-then-address, candidates lexicographically", () => {
  const list = roster({
    senders: ["+15550002222", "+15550002222"],
    recipients: ["Bo@x.com", "bo@x.com", "bo@x.com", "ana@x.com", "+15550002222"],
    names: { "bo@x.com": "Bo Ray", "ana@x.com": "Ana Ray", "+15550002222": "Bo Ray" },
  });
  const r = resolveRecipients(list, noEnv);
  assert.deepEqual(r.contacts, [
    { name: "Ana Ray", phones: [], emails: ["ana@x.com"] },
    { name: "Bo Ray", phones: ["+15550002222"], emails: ["bo@x.com"] },
  ]);
  // Belt-and-suspenders property (rule 7): one contact per canonical address, no
  // cross-contact address reuse -- no contact can ever mix two people's identities.
  const allEmails = r.contacts.flatMap((c) => c.emails);
  const allPhones = r.contacts.flatMap((c) => c.phones);
  assert.equal(new Set(allEmails).size, allEmails.length);
  assert.equal(new Set(allPhones).size, allPhones.length);
});

test("a named admitted phone with no same-name recipient email resolves as a phone-only contact carrying its name (no email fallback inferred)", () => {
  const list = roster({ senders: ["+15550002222"], names: { "+15550002222": "Kim Noemail" } });
  const r = resolveRecipients(list, noEnv);
  assert.deepEqual(r.contacts, [{ name: "Kim Noemail", phones: ["+15550002222"], emails: [] }]);
});

test("operator absorption rescues the operator phone from unresolvedPhones when the operator email hit a duplicate-nickname collision", () => {
  // Rule 3 strands the phone (ambiguous name); rule 4c then absorbs it into the
  // OPERATOR's email-only contact -- the explicit pair is trusted config, so the
  // phone leaves unresolvedPhones and never pairs with the other collision contact.
  const list = roster({
    senders: ["+15550003333"],
    recipients: ["op@x.com", "friend@x.com"],
    names: { "op@x.com": "Alex Kim", "friend@x.com": "Alex Kim", "+15550003333": "Alex Kim" },
  });
  const r = resolveRecipients(list, env({ OPERATOR_PHONE: "+15550003333", OPERATOR_EMAIL: "op@x.com" }));
  assert.deepEqual(r.contacts, [
    { name: "Alex Kim", phones: [], emails: ["friend@x.com"] },
    { name: "Alex Kim", phones: ["+15550003333"], emails: ["op@x.com"] },
  ]);
  assert.deepEqual(r.unresolvedPhones, []);
});

test("an operator phone stranded by a rule-3 collision leaves unresolvedPhones when the operator pair mints a NEW contact; the other collision phones remain", () => {
  // (The final-else analogue of the absorption test
  // above): opPhone's cleaned name collides across two distinct recipient
  // emails (rule 3 strands it) and the operator email is NOT among the
  // resolved candidates, so the pair mints a new contact carrying BOTH
  // addresses. The phone DELIVERS via that contact, so it must leave
  // unresolvedPhones -- never a false unresolved warning -- while the other
  // collision-member phone, rescued by no one, stays reported.
  const list = roster({
    senders: ["+15550003333", "+15550004444"],
    recipients: ["alex1@x.com", "alex2@x.com"],
    names: {
      "alex1@x.com": "Alex Kim",
      "alex2@x.com": "Alex Kim",
      "+15550003333": "Alex Kim",
      "+15550004444": "Alex Kim",
    },
  });
  const r = resolveRecipients(list, env({ OPERATOR_PHONE: "+15550003333", OPERATOR_EMAIL: "op@x.com" }));
  assert.deepEqual(r.contacts, [
    { name: "Alex Kim", phones: [], emails: ["alex1@x.com"] },
    { name: "Alex Kim", phones: [], emails: ["alex2@x.com"] },
    { name: "Alex Kim", phones: ["+15550003333"], emails: ["op@x.com"] },
  ]);
  assert.deepEqual(r.unresolvedPhones, ["+15550004444"], "the operator phone is rescued; the other collision phone is still reported");
});
