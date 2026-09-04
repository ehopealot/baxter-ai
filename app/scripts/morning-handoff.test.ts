import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalMorningOccurrence, decideInboundIdentity, directAudience, handoffPromptBlock,
  householdAudience, householdSafeGroup, isEligibleMorningHandoffTime, makeMorningClaim,
  retainEarliestClaim,
} from "./morning-handoff.ts";
import { prepareMorningHandoff } from "./morning-check-in.ts";
import { systemTaskPolicy, type SystemTaskDefinition } from "./system-tasks.ts";
import { systemTriggerKey } from "./system-reconcile.ts";
import type { Task } from "./schedule-store.ts";
import type { StoredEvent } from "./calendar-store.ts";
import type { ResolvedContact } from "./recipients.ts";

const tz = "America/Los_Angeles";
const definition: SystemTaskDefinition<string> = {
  key: "morning-check-in", desc: "Morning calendar and household check-in", cron: "0 8 * * *",
  window: { startHour: 8, minuteSlots: 60, cutoffHour: 12 }, execute: async () => ({ ok: true }),
};
const task = (overrides: Partial<Task> = {}): Task => ({
  id: "system:morning-check-in", desc: definition.desc, cron: definition.cron, tz,
  at: null, deliver: null, next_run_at: "2026-08-20T15:12:00.000Z",
  system: { key: definition.key, enabled: true, policy: systemTaskPolicy(definition) }, ...overrides,
});
const now = new Date("2026-08-20T13:00:00.000Z");
const list = { version: 1, senders: ["+15551234567", "+15557654321", "person@example.com", "alias@example.com"], recipients: ["+15551234567", "+15557654321", "person@example.com", "alias@example.com"], names: {} };
const contact = (name: string | undefined, phones: string[] = [], emails: string[] = []): ResolvedContact => ({ ...(name === undefined ? {} : { name }), phones, emails });

test("civil window is household-local, DST-safe, and rejects invalid sampled clocks", () => {
  assert.equal(isEligibleMorningHandoffTime(new Date("2026-08-20T12:59:59.000Z"), tz), false);
  assert.equal(isEligibleMorningHandoffTime(now, tz), true);
  assert.equal(isEligibleMorningHandoffTime(new Date("2026-08-20T19:00:00.000Z"), tz), false);
  assert.equal(isEligibleMorningHandoffTime(new Date("2026-03-08T13:00:00.000Z"), tz), true);
  assert.equal(isEligibleMorningHandoffTime(new Date("2026-11-01T14:00:00.000Z"), tz), true);
  assert.equal(isEligibleMorningHandoffTime(new Date("invalid"), tz), false);
});

test("canonical occurrence accepts present/future selected minutes and fails closed for canonical fields", () => {
  assert.equal(canonicalMorningOccurrence([task()], definition, now, tz), task().next_run_at);
  assert.equal(canonicalMorningOccurrence([task({ next_run_at: "2026-08-20T15:59:00.000Z" })], definition, now, tz), "2026-08-20T15:59:00.000Z");
  for (const bad of [
    task({ next_run_at: "not-a-date" }), task({ next_run_at: "2026-08-20T15:12:00Z" }),
    task({ next_run_at: "2026-08-20T15:12:01.000Z" }), task({ next_run_at: "2026-08-20T15:12:00.001Z" }),
    task({ next_run_at: "2026-08-19T15:12:00.000Z" }), task({ next_run_at: "2026-08-21T15:12:00.000Z" }),
    task({ id: "system:morning-check-in", system: { key: definition.key, enabled: false, policy: systemTaskPolicy(definition) } }),
    task({ id: "other" }), task({ desc: "wrong" }), task({ cron: "0 9 * * *" }), task({ tz: "UTC" }), task({ system: { key: definition.key, enabled: true, policy: "wrong" } }), task({ at: "2026-08-20T15:12:00.000Z" }), task({ deliver: { surface: "sms", target: "+15551234567" } }),
    { ...task(), task: "ordinary" } as Task, { ...task(), system_trigger: {} } as Task,
  ]) assert.equal(canonicalMorningOccurrence([bad], definition, now, tz), null);
  assert.equal(canonicalMorningOccurrence([task({ invisible_until: "2099-01-01T00:00:00.000Z" })], definition, now, tz), task().next_run_at);
  const manualTrigger = {
    id: "manual-morning-check-in", desc: definition.desc, cron: null, tz: null,
    at: "2026-08-20T15:12:00.000Z", next_run_at: "2026-08-20T15:12:00.000Z",
    invisible_until: null, attempts: 0, deliver: null,
    system_trigger: { key: "morning-check-in" }, created_at: "2026-08-20T15:12:00.000Z",
  } satisfies Task;
  // A structurally valid one-shot trigger coexists with, but never becomes, canonical authority.
  assert.equal(systemTriggerKey(manualTrigger, [definition]), "morning-check-in");
  assert.equal(canonicalMorningOccurrence([task(), manualTrigger], definition, now, tz), task().next_run_at);
  const ordinaryTask = {
    id: "ordinary-reminder", task: "Water the plants", desc: "Water the plants",
    cron: "0 9 * * *", tz, at: null, next_run_at: "2026-08-20T16:00:00.000Z",
    invisible_until: null, attempts: 0, deliver: null, created_at: "2026-08-20T13:00:00.000Z",
  } satisfies Task;
  assert.equal(canonicalMorningOccurrence([task(), ordinaryTask], definition, now, tz), task().next_run_at);
  assert.equal(canonicalMorningOccurrence([task(), task()], definition, now, tz), null);
  assert.equal(canonicalMorningOccurrence([task(), task({ id: "ordinary", system: task().system })], definition, now, tz), null);
  assert.equal(canonicalMorningOccurrence([task({ system: { key: "wrong", enabled: true, policy: systemTaskPolicy(definition) } })], definition, now, tz), null);
  assert.equal(canonicalMorningOccurrence([task()], undefined, now, tz), null);
});

test("canonicalization accepts a past 08:xx selection after 08:00 and follows exact civil boundaries", () => {
  const afterEight = new Date("2026-08-20T15:30:00.000Z"); // 08:30 PDT
  assert.equal(canonicalMorningOccurrence([task()], definition, afterEight, tz), task().next_run_at);
  assert.equal(canonicalMorningOccurrence([task()], definition, new Date("2026-08-20T14:59:00.000Z"), tz), task().next_run_at); // 07:59 PDT
  assert.equal(canonicalMorningOccurrence([task()], definition, new Date("2026-08-20T16:00:00.000Z"), tz), task().next_run_at); // 09:00 PDT
});

test("canonicalization traps malformed Date conversion and never trusts provider time", () => {
  const malformed = task({ next_run_at: "2026-99-99T99:99:99.999Z" });
  assert.doesNotThrow(() => canonicalMorningOccurrence([malformed], definition, now, tz));
  assert.equal(canonicalMorningOccurrence([malformed], definition, now, tz), null);
  // The caller supplies daemon now; a provider's unrelated timestamp cannot alter this result.
  assert.equal(canonicalMorningOccurrence([task()], definition, new Date("2026-08-20T19:00:00.000Z"), tz), null);
});

test("identity seam admits aliases and unmatched directs, but ambiguity and non-household groups do not mutate", () => {
  const roster = [contact("Pat", ["+15551234567"], ["person@example.com", "alias@example.com"]), contact("Robin", ["+15557654321"])];
  const matched = decideInboundIdentity({ type: "direct", address: " ALIAS@example.com ", allowlist: list, roster });
  assert.equal(matched.kind, "direct");
  if (matched.kind === "direct") assert.equal(matched.directConsume.contact, roster[0]);
  const unmatched = decideInboundIdentity({ type: "direct", address: "person@example.com", allowlist: list, roster: [contact("One"), contact("One"), contact(undefined)] });
  assert.equal(unmatched.kind, "direct");
  if (unmatched.kind === "direct") assert.deepEqual(unmatched.audience.recipient, { currentRecipientDisplayName: null, otherNamedHouseholdMembers: ["One", "One"], omittedOtherNamedRecipientCount: 0 });
  const ambiguous = decideInboundIdentity({ type: "direct", address: "person@example.com", allowlist: list, roster: [contact("A", [], ["person@example.com"]), contact("B", [], ["person@example.com"])] });
  assert.deepEqual(ambiguous, { kind: "none", reason: "ambiguous" });
  assert.deepEqual(decideInboundIdentity({ type: "group", payload: { group_id: "room", from: "+15550000000", participants: ["+15550000000"] }, allowlist: list, roster }), { kind: "none", reason: "not-admitted" });
  const unsafe = decideInboundIdentity({ type: "group", payload: { group_id: "room", from: "+15551234567", participants: ["+15551234567", "+15550000000"] }, allowlist: list, roster });
  assert.equal(unsafe.kind, "shared"); if (unsafe.kind === "shared") assert.deepEqual(unsafe.sharedClose, { contextEligible: false });
});

test("strict group safety accepts exact boundaries and rejects incomplete participant snapshots", () => {
  for (const id of ["a".repeat(64), ".room", "_room", "-room"]) assert.equal(householdSafeGroup({ group_id: id, from: "+15551234567", participants: ["+15551234567", "+15557654321"] }, list, undefined), true);
  for (const id of ["", "a".repeat(65), " bad", "a/b"]) assert.equal(householdSafeGroup({ group_id: id, from: "+15551234567", participants: ["+15551234567"] }, list, undefined), false);
  assert.equal(householdSafeGroup({ group_id: "room", from: "+15551234567", participants: ["+15557654321"] }, list, undefined), false);
  assert.equal(householdSafeGroup({ group_id: "room", from: "+15551234567", participants: ["+15551234567", 1] }, list, undefined), false);
  assert.equal(householdSafeGroup({ group_id: "room", from: "+15551234567", participants: ["+15551234567", "+15557654321"] }, list, "+15557654321"), true);
});

test("direct roster preserves order and duplicates while household roster cleans, deduplicates, sorts, and bounds", () => {
  const roster = [contact(" Zoe "), contact("Zoe"), contact("\u0000Ana"), contact("\ud800"), contact("Åke"), contact("åke")];
  assert.deepEqual(directAudience(null, "person@example.com", roster), { currentRecipientDisplayName: null, otherNamedHouseholdMembers: ["Zoe", "Zoe", "Ana", "�", "Åke", "åke"], omittedOtherNamedRecipientCount: 0 });
  assert.deepEqual(householdAudience(roster), { kind: "household", names: ["åke", "Åke", "Ana", "Zoe", "�"], omittedCount: 0 });
  const many = Array.from({ length: 42 }, (_, i) => contact(`Member ${i}`));
  assert.equal(directAudience(null, "person@example.com", many)!.otherNamedHouseholdMembers.length, 20);
  assert.equal(directAudience(null, "person@example.com", many)!.omittedOtherNamedRecipientCount, 22);
  assert.equal(householdAudience(many).names.length, 40);
  assert.equal(householdAudience(many).omittedCount, 2);
  assert.equal(householdAudience([contact("x".repeat(100))]).names[0]!.length, 80);
});

test("claims retain the earliest durable winner and clone direct and household winning snapshots", () => {
  const sourceAudience = { kind: "household" as const, names: ["Winner"], omittedCount: 0 };
  const capturedAt = new Date(now);
  const first = makeMorningClaim(task().next_run_at, capturedAt, sourceAudience);
  sourceAudience.names[0] = "Mutated";
  capturedAt.setUTCMinutes(59);
  const directSource = {
    kind: "direct" as const,
    recipient: { currentRecipientDisplayName: "Pat", otherNamedHouseholdMembers: ["Robin"], omittedOtherNamedRecipientCount: 0 },
  };
  const direct = makeMorningClaim(task().next_run_at, new Date(now), directSource);
  directSource.recipient.currentRecipientDisplayName = "Mutated Pat";
  directSource.recipient.otherNamedHouseholdMembers[0] = "Mutated Robin";
  const later = makeMorningClaim(task().next_run_at, new Date("2026-08-20T13:01:00.000Z"), { kind: "household", names: ["Later"], omittedCount: 0 });
  assert.deepEqual(first.audience, { kind: "household", names: ["Winner"], omittedCount: 0 });
  assert.deepEqual(direct.audience, {
    kind: "direct",
    recipient: { currentRecipientDisplayName: "Pat", otherNamedHouseholdMembers: ["Robin"], omittedOtherNamedRecipientCount: 0 },
  });
  assert.equal(first.consumedAt.toISOString(), now.toISOString());
  assert.equal(retainEarliestClaim(first, later), first);
  assert.equal(retainEarliestClaim(null, later), later);
  assert.equal(retainEarliestClaim(first, null), first);
  assert.equal(retainEarliestClaim(null, null), null);
});

test("canonical collision and registered-definition matrix fails closed without selecting a best effort record", () => {
  const cases: Array<[readonly Task[], SystemTaskDefinition<string> | undefined]> = [
    [[task(), task()], definition],
    [[task(), task({ id: "ordinary", system: task().system })], definition],
    [[task({ system: { key: "wrong-key", enabled: true, policy: systemTaskPolicy(definition) } })], definition],
    [[task(), task({ id: "system:unknown", system: { key: "unknown", enabled: true, policy: "unknown" } })], definition],
    [[task()], { ...definition, key: "not-morning" }],
    [[task()], { ...definition, window: { startHour: 8, minuteSlots: 59, cutoffHour: 12 } }],
    [[task()], { ...definition, cron: "0 9 * * *" }],
  ];
  for (const [tasks, registered] of cases) assert.equal(canonicalMorningOccurrence(tasks, registered, now, tz), null);
});

test("direct and group identity matrix preserves exact roster and group safety boundaries", () => {
  const names = Array.from({ length: 22 }, (_, i) => contact(`Name ${i}`));
  const unmatched = decideInboundIdentity({ type: "direct", address: "person@example.com", allowlist: list, roster: names });
  assert.equal(unmatched.kind, "direct");
  if (unmatched.kind === "direct") assert.deepEqual(unmatched.audience.recipient, {
    currentRecipientDisplayName: null,
    otherNamedHouseholdMembers: Array.from({ length: 20 }, (_, i) => `Name ${i}`),
    omittedOtherNamedRecipientCount: 2,
  });
  const roster = [contact("Pat", ["+15551234567"]), contact("Robin", ["+15557654321"])];
  const base = { type: "group" as const, allowlist: list, roster };
  for (const payload of [
    { group_id: "room", from: "+15551234567", participants: ["+15551234567", "+15557654321"] },
    { group_id: "room", from: "+15551234567", participants: ["+15551234567"] },
    { group_id: "room", from: "+15551234567", participants: ["+15551234567", "+15557654321", "+15550000000"] },
    { group_id: "room", from: "+15551234567", participants: [] },
    { group_id: "room", from: "+15551234567", participants: undefined },
    { group_id: " bad", from: "+15551234567", participants: ["+15551234567"] },
  ]) {
    const decision = decideInboundIdentity({ ...base, payload });
    assert.equal(decision.kind, "shared");
  }
  assert.equal(decideInboundIdentity({ ...base, baxterNumber: "+15557654321", payload: { group_id: "room", from: "+15551234567", participants: ["+15551234567", "+15557654321"] } }).kind, "shared");
  assert.deepEqual(decideInboundIdentity({ ...base, payload: { group_id: "room", from: "+15550000000", participants: ["+15550000000"] } }), { kind: "none", reason: "not-admitted" });
});

test("typed calendar packets project only approved fields", () => {
  const direct = { kind: "direct" as const, recipient: { currentRecipientDisplayName: null, otherNamedHouseholdMembers: ["Pat"], omittedOtherNamedRecipientCount: 0 } };
  const enrichedDirect = {
    ...direct,
    recipient: { ...direct.recipient, email: "recipient-secret@example.com", phone: "+15550001111", provider: "mail" },
  };
  const sourceEvent = {
    when: "9:00 AM", title: "Meeting", location: "HQ", allDay: false, ongoing: false,
    id: "calendar-source-id", url: "https://calendar.example/private", description: "private description",
    provider: "calendar-provider", source: { feed: "secret-feed" }, email: "event-secret@example.com",
  };
  const calendar = handoffPromptBlock({ mode: "calendar", audience: enrichedDirect, events: [sourceEvent] as never, omittedCount: 2, localDate: "2026-08-20", weekday: "Wednesday" });
  assert.match(calendar, /current delivery recipient/);
  assert.match(calendar, /2026-08-20/); assert.match(calendar, /Wednesday/); assert.match(calendar, /Meeting/);
  for (const secret of ["recipient-secret@example.com", "+15550001111", "calendar-source-id", "https://calendar.example/private", "private description", "calendar-provider", "secret-feed", "event-secret@example.com"]) assert.doesNotMatch(calendar, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const calendarJson = calendar.match(/=== CALENDAR DATA BEGIN ===\n(.*?)\n=== CALENDAR DATA END ===/s)?.[1];
  assert.deepEqual(Object.keys(JSON.parse(calendarJson!).events[0]).sort(), ["allDay", "location", "ongoing", "title", "when"]);
  assert.doesNotMatch(calendar, /runtime adds the greeting/);
  // Extra runtime fields are ignored rather than concatenated across the prompt boundary.
  const adversarial = handoffPromptBlock({ mode: "calendar", audience: direct, events: [], omittedCount: 0, localDate: "2026-08-20", weekday: "Wednesday", triggerEmail: "secret@example.com", group_id: "provider-group", token: "deadbeef" } as never);
  assert.doesNotMatch(adversarial, /secret@example\.com|provider-group|deadbeef/);
  assert.equal(handoffPromptBlock({ mode: "none" }), "");
});

test("prompt rules contain ownership, answer-first, sensitivity, hidden-mechanics, and scheduling-control boundaries", () => {
  const household = handoffPromptBlock({ mode: "calendar", audience: { kind: "household", names: ["Pat"], omittedCount: 0 }, events: [], omittedCount: 0, localDate: "2026-08-20", weekday: "Wednesday" });
  for (const phrase of ["Answer the person's actual request first", "within the reply", "never as a second standalone message", "urgent, safety-related, grief-heavy", "Never disclose sidecar, suppression, consumption, prevented outbound", "Never print data delimiters", "scheduler, selected time, or morning check-in", "explicit user scheduling question or control", "No household member is the default referent", "named facts attributed", "ownerless fact"]) assert.match(household, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // Scheduling vocabulary is permitted only for an explicit scheduling request/control,
  // not an unrelated conversational turn or the unsolicited aside itself.
  assert.match(household, /only to answer or execute an explicit user scheduling question or control/);
  assert.match(household, /For an unsolicited aside, do not mention the scheduler/);
  assert.doesNotMatch(household, /currentRecipientDisplayName|delivery recipient/);
});

test("mail-authorized operator email retains its existing authority without admitting non-roster SMS", () => {
  const envOnlyOperator = "operator@example.com";
  const roster = [contact("Operator", [], [envOnlyOperator]), contact("Pat", ["+15551234567"])];
  const noOperatorInArrays = { ...list, senders: ["+15551234567"], recipients: ["+15551234567"] };
  const matched = decideInboundIdentity({ type: "direct", address: " OPERATOR@EXAMPLE.COM ", allowlist: noOperatorInArrays, roster, emailAlreadyAuthorized: true });
  assert.deepEqual(matched, {
    kind: "direct", directConsume: { address: envOnlyOperator, contact: roster[0] },
    audience: { kind: "direct", recipient: { currentRecipientDisplayName: "Operator", otherNamedHouseholdMembers: ["Pat"], omittedOtherNamedRecipientCount: 0 } },
  });
  const unmatched = decideInboundIdentity({ type: "direct", address: envOnlyOperator, allowlist: noOperatorInArrays, roster: [contact("One"), contact("One")] , emailAlreadyAuthorized: true });
  assert.deepEqual(unmatched, {
    kind: "direct", directConsume: { address: envOnlyOperator, contact: null },
    audience: { kind: "direct", recipient: { currentRecipientDisplayName: null, otherNamedHouseholdMembers: ["One", "One"], omittedOtherNamedRecipientCount: 0 } },
  });
  assert.deepEqual(decideInboundIdentity({ type: "direct", address: "+15550000000", allowlist: noOperatorInArrays, roster, emailAlreadyAuthorized: true }), { kind: "none", reason: "not-admitted" });
  assert.deepEqual(decideInboundIdentity({ type: "direct", address: "not-an-email", allowlist: noOperatorInArrays, roster, emailAlreadyAuthorized: true }), { kind: "none", reason: "not-admitted" });
});

test("canonical selected-minute, complete group, and bounded audience matrix stays fail closed", () => {
  for (const selected of ["2026-08-20T14:59:00.000Z", "2026-08-20T16:00:00.000Z"]) {
    assert.equal(canonicalMorningOccurrence([task({ next_run_at: selected })], definition, now, tz), null);
  }
  for (const malformed of [
    { ...task(), next_run_at: undefined },
    { ...task(), system: undefined },
    { ...task(), system: { key: definition.key, enabled: true } },
  ] as Task[]) assert.equal(canonicalMorningOccurrence([malformed], definition, now, tz), null);
  const roster = [contact("Pat", ["+15551234567"]), contact("Robin", ["+15557654321"])];
  const group = (payload: { group_id?: string; participants?: unknown; from: string }) => decideInboundIdentity({ type: "group", payload, allowlist: list, roster, baxterNumber: "+15559999999" });
  const safe = group({ group_id: "room", from: "+15551234567", participants: ["+15551234567"] });
  assert.deepEqual(safe, { kind: "shared", sharedClose: { contextEligible: true }, audience: { kind: "household", names: ["Pat", "Robin"], omittedCount: 0 } });
  // Duplicate canonical participant values collapse and remain a safe subset.
  assert.deepEqual(group({ group_id: "room", from: "+15551234567", participants: ["+15551234567", "+15551234567"] }), safe);
  for (const payload of [
    { group_id: " bad", from: "+15551234567", participants: ["+15551234567"] },
    { group_id: "room", from: "+15551234567", participants: ["+15559999999"] },
    { group_id: "room", from: "+15551234567", participants: ["+15551234567", "+15550000000"] },
    { group_id: "room", from: "+15551234567", participants: ["+15557654321"] },
  ]) {
    const silent = group(payload);
    assert.deepEqual(silent, { kind: "shared", sharedClose: { contextEligible: false }, audience: null });
  }
  const astral = "😀".repeat(81);
  const audience = householdAudience([contact(null as never), contact(astral), contact("  😀".repeat(2)), contact("Beta")]);
  assert.ok(audience.names.includes("Beta"));
  assert.ok(!audience.names.some(name => name === ""));
  assert.equal(Array.from(audience.names.find(name => Array.from(name).length === 80) ?? "").length, 80);
});

test("canonical occurrence civil-date and definition matrix rejects every unavailable authority", () => {
  const dstCases: Array<[string, string, string, string]> = [
    // Each selected instant is a valid local 08:xx recurrence minute. DST offset changes
    // must not make a prior/next civil-date fixture fail before the date comparison.
    ["2026-03-08T13:00:00.000Z", "2026-03-08T15:00:00.000Z", "2026-03-07T16:00:00.000Z", "2026-03-09T15:00:00.000Z"],
    ["2026-11-01T14:00:00.000Z", "2026-11-01T16:00:00.000Z", "2026-10-31T15:00:00.000Z", "2026-11-02T16:00:00.000Z"],
  ];
  for (const [sampledNow, selected, priorCivilDate, nextCivilDate] of dstCases) {
    const sampled = new Date(sampledNow);
    assert.equal(canonicalMorningOccurrence([task({ next_run_at: selected })], definition, sampled, tz), selected);
    assert.equal(canonicalMorningOccurrence([task({ next_run_at: priorCivilDate })], definition, sampled, tz), null);
    assert.equal(canonicalMorningOccurrence([task({ next_run_at: nextCivilDate })], definition, sampled, tz), null);
  }
  const missing = (field: "at" | "deliver" | "desc" | "cron" | "tz"): Task => {
    const value: Record<string, unknown> = { ...task() };
    delete value[field];
    return value as unknown as Task;
  };
  const unavailable: Array<[Task, SystemTaskDefinition<string> | undefined]> = [];
  for (const field of ["at", "deliver", "desc", "cron", "tz"] as const) unavailable.push([missing(field), definition]);
  unavailable.push(
    [task({ system: { key: definition.key, enabled: "true" as never, policy: systemTaskPolicy(definition) } }), definition],
    [task(), { ...definition, desc: "Different description" }],
    [task(), { ...definition, window: { startHour: 7, minuteSlots: 60, cutoffHour: 12 } }],
    [task(), { ...definition, window: { startHour: 8, minuteSlots: 60, cutoffHour: 11 } }],
  );
  for (const [record, registered] of unavailable) assert.equal(canonicalMorningOccurrence([record], registered, now, tz), null);
});

test("identity decisions expose exact direct and shared safe-or-silent audiences", () => {
  const roster = [contact("Pat", ["+15551234567"], ["person@example.com"]), contact("Robin", ["+15557654321"])];
  assert.deepEqual(decideInboundIdentity({ type: "direct", address: "+15551234567", allowlist: list, roster }), {
    kind: "direct", directConsume: { address: "+15551234567", contact: roster[0] },
    audience: { kind: "direct", recipient: { currentRecipientDisplayName: "Pat", otherNamedHouseholdMembers: ["Robin"], omittedOtherNamedRecipientCount: 0 } },
  });
  assert.deepEqual(decideInboundIdentity({ type: "direct", address: "+15550000000", allowlist: list, roster }), { kind: "none", reason: "not-admitted" });
  // An admitted phone with no roster owner remains a direct winner, without guessed identity.
  assert.deepEqual(decideInboundIdentity({ type: "direct", address: "+15557654321", allowlist: list, roster: [contact("Pat"), contact("Robin")] }), {
    kind: "direct", directConsume: { address: "+15557654321", contact: null },
    audience: { kind: "direct", recipient: { currentRecipientDisplayName: null, otherNamedHouseholdMembers: ["Pat", "Robin"], omittedOtherNamedRecipientCount: 0 } },
  });
  const safeAudience = { kind: "household" as const, names: ["Pat", "Robin"], omittedCount: 0 };
  const cases: Array<[string, { group_id?: string; from: string; participants?: unknown }, unknown]> = [
    ["safe", { group_id: "room", from: "+15551234567", participants: ["+15551234567", "+15557654321"] }, { kind: "shared", sharedClose: { contextEligible: true }, audience: safeAudience }],
    ["invalid group id", { group_id: " bad", from: "+15551234567", participants: ["+15551234567"] }, { kind: "shared", sharedClose: { contextEligible: false }, audience: null }],
    ["empty group id", { group_id: "", from: "+15551234567", participants: ["+15551234567"] }, { kind: "shared", sharedClose: { contextEligible: false }, audience: null }],
    ["missing participants", { group_id: "room", from: "+15551234567" }, { kind: "shared", sharedClose: { contextEligible: false }, audience: null }],
    ["non-string participant", { group_id: "room", from: "+15551234567", participants: ["+15551234567", 7] }, { kind: "shared", sharedClose: { contextEligible: false }, audience: null }],
    ["outsider", { group_id: "room", from: "+15551234567", participants: ["+15551234567", "+15550000000"] }, { kind: "shared", sharedClose: { contextEligible: false }, audience: null }],
    ["sender omitted", { group_id: "room", from: "+15551234567", participants: ["+15557654321"] }, { kind: "shared", sharedClose: { contextEligible: false }, audience: null }],
    ["all Baxter", { group_id: "room", from: "+15551234567", participants: ["+15559999999"] }, { kind: "shared", sharedClose: { contextEligible: false }, audience: null }],
  ];
  for (const [, payload, expected] of cases) assert.deepEqual(decideInboundIdentity({ type: "group", payload, allowlist: list, roster, baxterNumber: "+15559999999" }), expected);
});

test("audience cap boundaries retain direct roster semantics and household cleaned ordering", () => {
  const directRoster = [contact(null as never), contact(" \u0000Alpha "), contact("Alpha"), contact("\ud800"), ...Array.from({ length: 20 }, (_, i) => contact(`N${i}`))];
  assert.deepEqual(directAudience(null, "person@example.com", directRoster), {
    currentRecipientDisplayName: null,
    otherNamedHouseholdMembers: ["Alpha", "Alpha", "�", ...Array.from({ length: 17 }, (_, i) => `N${i}`)],
    omittedOtherNamedRecipientCount: 3,
  });
  const householdRoster = [contact(null as never), contact("\u0000Alpha"), contact("Alpha"), contact("\ud800"), ...Array.from({ length: 40 }, (_, i) => contact(`N${String(i).padStart(2, "0")}`))];
  const household = householdAudience(householdRoster);
  assert.deepEqual(household, {
    kind: "household",
    names: ["Alpha", ...Array.from({ length: 39 }, (_, i) => `N${String(i).padStart(2, "0")}`)],
    omittedCount: 2,
  });
});

test("captured claim preparation uses its pre-noon instant and rejects advanced or disabled authority", async () => {
  const claim = makeMorningClaim(task().next_run_at, new Date("2026-08-20T18:59:59.000Z"), {
    kind: "direct",
    recipient: { currentRecipientDisplayName: "Pat", otherNamedHouseholdMembers: [], omittedOtherNamedRecipientCount: 0 },
  });
  let snapshots = [task()];
  const base = {
    env: { BAXTER_TZ: tz },
    readTasksForMorningHandoffImpl: () => ({ available: true as const, tasks: snapshots }),
    refreshImpl: async () => ({ urls: [], ok: true, events: [], errors: [], wroteCache: false, familySnapshot: [], retainedSnapshotAvailable: true }),
    readOwnEventsImpl: () => [
      { uid: "captured", title: "Captured event", start: "2026-08-20T19:30:00.000Z", end: "2026-08-20T20:00:00.000Z", created: "", updated: "" },
    ],
    runAgentImpl: async () => { throw new Error("preparation never runs an agent"); },
  };
  const packet = await prepareMorningHandoff(claim, base);
  assert.deepEqual(packet && { mode: packet.mode, localDate: packet.mode === "calendar" ? packet.localDate : null, events: packet.mode === "calendar" ? packet.events.map(event => event.title) : [] }, {
    mode: "calendar", localDate: "2026-08-20", events: ["Captured event"],
  });
  // Recheck is against the same occurrence and captured instant, not the wall clock
  // at debounce completion. A changed or disabled canonical record cannot reopen claim state.
  snapshots = [task({ next_run_at: "2026-08-21T15:12:00.000Z" })];
  assert.equal(await prepareMorningHandoff(claim, base), null);
  snapshots = [task({ system: { key: definition.key, enabled: false, policy: systemTaskPolicy(definition) } })];
  assert.equal(await prepareMorningHandoff(claim, base), null);
});

test("prepared packets return calendar-only data and retain cached calendar success", async () => {
  const audience = { kind: "direct" as const, recipient: { currentRecipientDisplayName: "Pat", otherNamedHouseholdMembers: [], omittedOtherNamedRecipientCount: 0 } };
  const prepare = (now: string, own: readonly StoredEvent[]) => {
    const occurrence = now.replace("16:00:00.000Z", "15:00:00.000Z");
    return prepareMorningHandoff(makeMorningClaim(occurrence, new Date(now), audience), {
      env: { BAXTER_TZ: tz }, readTasksForMorningHandoffImpl: () => ({ available: true as const, tasks: [task({ next_run_at: occurrence })] }),
      refreshImpl: async () => ({ urls: [], ok: true, events: [], errors: [], wroteCache: false, familySnapshot: [], retainedSnapshotAvailable: true }),
      readOwnEventsImpl: () => [...own],
    });
  };
  assert.deepEqual(await prepare("2026-08-20T16:00:00.000Z", [{ uid: "calendar", title: "Calendar event", start: "2026-08-20T18:00:00.000Z", end: "2026-08-20T19:00:00.000Z", created: "", updated: "" }]), {
    mode: "calendar", audience, events: [{ when: "11:00 AM – 12:00 PM", title: "Calendar event", allDay: false, ongoing: false }], omittedCount: 0, localDate: "2026-08-20", weekday: "Thursday",
  });
  assert.deepEqual(await prepare("2026-08-21T16:00:00.000Z", [{ uid: "weekend", title: "Weekend title", start: "2026-08-22T18:00:00.000Z", end: "2026-08-22T19:00:00.000Z", created: "", updated: "" }]), { mode: "none" });
  assert.deepEqual(await prepare("2026-08-24T16:00:00.000Z", []), { mode: "none" });
  assert.deepEqual(await prepare("2026-08-20T16:00:00.000Z", []), { mode: "none" });
  const retainedOccurrence = "2026-08-21T15:00:00.000Z";
  assert.deepEqual(await prepareMorningHandoff(makeMorningClaim(retainedOccurrence, new Date("2026-08-21T16:00:00.000Z"), audience), {
    env: { BAXTER_TZ: tz }, readTasksForMorningHandoffImpl: () => ({ available: true as const, tasks: [task({ next_run_at: retainedOccurrence })] }),
    refreshImpl: async () => { throw new Error("poll failed"); }, feedUrlsImpl: () => ["https://feed.test/x.ics"],
    readFamilyCacheImpl: () => ({ available: true, events: [{ uid: "retained", title: "Retained calendar event", location: null, startMs: Date.parse("2026-08-21T18:00:00.000Z"), endMs: Date.parse("2026-08-21T19:00:00.000Z"), allDay: false, rrule: null, url: null }] }),
    readOwnEventsImpl: () => [],
  }), { mode: "calendar", audience, events: [{ when: "11:00 AM – 12:00 PM", title: "Retained calendar event", allDay: false, ongoing: false }], omittedCount: 0, localDate: "2026-08-21", weekday: "Friday" });
});

test("preparation failures never reach model, quota, or provider delivery seams", async () => {
  const claim = makeMorningClaim(task().next_run_at, new Date("2026-08-20T16:00:00.000Z"), { kind: "household", names: ["Pat"], omittedCount: 0 });
  const calls = { agent: 0, sms: 0, email: 0 };
  const common = {
    env: { BAXTER_TZ: tz }, readTasksForMorningHandoffImpl: () => ({ available: true as const, tasks: [task()] }),
    runAgentImpl: async () => { calls.agent++; throw new Error("must not run"); },
    sendSmsImpl: async () => { calls.sms++; throw new Error("must not send"); },
    sendNewImpl: async () => { calls.email++; throw new Error("must not send"); },
  };
  const unavailable = await prepareMorningHandoff(claim, { ...common, refreshImpl: async () => ({ urls: ["https://feed.test"], ok: false, events: [], errors: [], wroteCache: false, familySnapshot: [], retainedSnapshotAvailable: false }), readOwnEventsImpl: () => [] });
  const malformedFresh = await prepareMorningHandoff(claim, { ...common, refreshImpl: async () => ({ urls: ["https://feed.test"], ok: true, events: [], errors: [], wroteCache: false, familySnapshot: [{}] as never, retainedSnapshotAvailable: true }), readOwnEventsImpl: () => [] });
  const malformedRetained = await prepareMorningHandoff(claim, { ...common, refreshImpl: async () => { throw new Error("offline"); }, feedUrlsImpl: () => ["https://feed.test"], readFamilyCacheImpl: () => ({ available: true, events: [{}] as never }), readOwnEventsImpl: () => [] });
  const unavailableAuthority = await prepareMorningHandoff(claim, { ...common, readTasksForMorningHandoffImpl: () => ({ available: false as const, tasks: [] }), refreshImpl: async () => { throw new Error("must not read calendar"); } });
  assert.deepEqual([unavailable, malformedFresh, malformedRetained, unavailableAuthority], [null, null, null, null]);
  assert.deepEqual(calls, { agent: 0, sms: 0, email: 0 });
});

test("prompt projection excludes extra routing fields and retains its narrow control exception", () => {
  const audience = { kind: "direct" as const, recipient: { currentRecipientDisplayName: "Pat", otherNamedHouseholdMembers: [], omittedOtherNamedRecipientCount: 0, chatId: "chat-secret", email: "mail-secret@example.com" } };
  const prohibited = ["calendar-time", "calendar-date", "calendar-location", "calendar-url", "calendar-omitted", "calendar-itinerary", "chat-secret", "mail-secret@example.com", "group-secret", "phone-secret", "token-secret"];
  const packet = { mode: "calendar" as const, audience, events: [], omittedCount: 0, localDate: "2026-08-20", weekday: "Wednesday", when: "calendar-time", date: "calendar-date", location: "calendar-location", url: "calendar-url", itinerary: "calendar-itinerary", group_id: "group-secret", phone: "phone-secret", token: "token-secret" };
  const block = handoffPromptBlock(packet as never);
  for (const value of prohibited) assert.ok(!block.includes(value), value);
  const control = handoffPromptBlock({ mode: "calendar", audience, events: [], omittedCount: 0, localDate: "2026-08-20", weekday: "Wednesday" });
  assert.match(control, /only to answer or execute an explicit user scheduling question or control/);
  assert.match(control, /For an unsolicited aside, do not mention the scheduler, selected time, or morning check-in/);
  assert.match(control, /Never disclose sidecar, suppression, consumption, prevented outbound, or hidden handoff mechanics/);
});
