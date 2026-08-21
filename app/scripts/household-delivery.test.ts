import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverToHousehold } from "./household-delivery.ts";
import type { ResolvedContact } from "./recipients.ts";

const contacts: ResolvedContact[] = [
  { name: "Alex", phones: ["+15550000001", "+15550000002"], emails: ["alex@example.com"] },
  { name: "Blair", phones: ["+15550000003"], emails: ["blair@example.com"] },
];

test("household delivery is sequential SMS-first and preserves the exact per-contact body for same-contact email fallback", async () => {
  const attempts: Array<{ channel: string; target: string; body: string }> = [];
  const logs: string[] = [];
  const result = await deliverToHousehold({
    contacts,
    subjectFor: (_contact, index) => `Neutral subject ${index}`,
    bodyFor: (contact) => `Hi ${contact.name} — shared body`,
    sendSms: async (phone, body) => {
      attempts.push({ channel: "sms", target: phone, body });
      if (phone !== "+15550000003") throw new Error("provider refused");
    },
    sendEmail: async (email, _subject, body) => attempts.push({ channel: "email", target: email, body }),
    log: (message) => logs.push(message),
    taskLabel: "weekly check-in",
  });

  assert.deepEqual(attempts.map(({ channel, target }) => [channel, target]), [
    ["sms", "+15550000001"], ["sms", "+15550000002"], ["email", "alex@example.com"],
    ["sms", "+15550000003"],
  ]);
  assert.equal(attempts[0]!.body, attempts[2]!.body, "email gets the byte-identical body attempted by SMS");
  assert.deepEqual(result, { contacts: 2, sms: 1, email: 1, failed: 0 });
  assert.ok(logs.every((line) => !line.includes("shared body") && !line.includes("Neutral subject")), "logs contain no body/subject");
});

test("provider diagnostics are bounded, single-line, and never copy arbitrary provider text or partial/transformed outbound echoes", async () => {
  const logs: string[] = [];
  const body = "PRIVATE OUTBOUND BODY WITH FAMILY DETAILS";
  const subject = "PRIVATE SUBJECT";
  const prefix = body.slice(0, 22);
  const suffix = body.slice(-20);
  await deliverToHousehold({
    contacts: [{ name: "Dana", phones: ["+15550000001"], emails: ["dana@example.com"] }],
    subjectFor: () => subject,
    bodyFor: () => body,
    sendSms: async () => { throw new Error(`provider preview: ${prefix}\n${"x".repeat(2000)}`); },
    sendEmail: async () => { throw Object.assign(new Error(`suffix=${suffix.toUpperCase()} ${subject.toLowerCase()}`), { code: "PROVIDER_REJECTED" }); },
    log: (line) => logs.push(line),
    taskLabel: "task",
  });
  assert.equal(logs.length, 1);
  for (const forbidden of [body, subject, prefix, suffix.toUpperCase(), subject.toLowerCase(), "provider preview", "x".repeat(20)]) {
    assert.ok(!logs[0]!.includes(forbidden), `diagnostic leaked ${JSON.stringify(forbidden)}`);
  }
  assert.match(logs[0]!, /contact=0/);
  assert.match(logs[0]!, /channel=sms category=/);
  assert.match(logs[0]!, /channel=email category=.*code=PROVIDER_REJECTED/);
  assert.ok(!logs[0]!.includes("Dana") && !logs[0]!.includes("+1555") && !logs[0]!.includes("@example.com"));
  assert.ok(!logs[0]!.includes("\n"));
  assert.ok(logs[0]!.length <= 1200);
});

test("provider diagnostics retain accepted structural codes and omit every invalid code entirely", async () => {
  const acceptedLogs: string[] = [];
  await deliverToHousehold({
    contacts: [{ phones: ["+15550000001"], emails: [] }],
    subjectFor: () => "Subject", bodyFor: () => "Body",
    sendSms: async () => { throw Object.assign(new Error("rate limit"), { code: "RATE_LIMIT_2" }); },
    sendEmail: async () => {}, log: (line) => acceptedLogs.push(line), taskLabel: "task",
  });
  assert.match(acceptedLogs[0]!, /channel=sms category=cap code=RATE_LIMIT_2/);

  for (const invalidCode of ["lower_case", "HAS-HYPHEN", "2STARTS_WITH_DIGIT", "A".repeat(65), "BAD CODE", 42, null]) {
    const logs: string[] = [];
    await deliverToHousehold({
      contacts: [{ phones: ["+15550000001"], emails: [] }],
      subjectFor: () => "Subject", bodyFor: () => "Body",
      sendSms: async () => { throw Object.assign(new Error("down"), { code: invalidCode }); },
      sendEmail: async () => {}, log: (line) => logs.push(line), taskLabel: "task",
    });
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0]!, /\bcode=/, String(invalidCode));
  }
});

test("household delivery continues after a contact fails and reports only aggregates", async () => {
  const result = await deliverToHousehold({
    contacts: [{ phones: ["+15550000001"], emails: [] }, { phones: [], emails: ["ok@example.com"] }],
    subjectFor: () => "Subject",
    bodyFor: () => "private body",
    sendSms: async () => { throw new Error("down"); },
    sendEmail: async () => {},
    log: () => {},
    taskLabel: "task",
  });
  assert.deepEqual(result, { contacts: 2, sms: 0, email: 1, failed: 1 });
  assert.equal("body" in result, false);
});
