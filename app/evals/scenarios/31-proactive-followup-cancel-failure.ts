import type { Scenario } from "../harness.ts";
import { calledCliWith, cliCallCount, delivered, replyMatches, replyOmits } from "../assertions.ts";

export default {
  name: "proactive follow-up: failed cancellation never promises prevention",
  surface: "sms",
  slots: { HISTORY: "The person: The Friday August 28 store trip is off. Cancel its check-in." },
  mocks: {
    "followup-cli": { list: JSON.stringify([{ id: "follow-store", subject: "store trip", plan_date: "2026-08-28", next_run_at: "2026-08-27T20:00:00.000Z", origin: { surface: "mail-thread" }, desc: "Check back about store trip" }]) },
    "schedule-cli": { cancel: "ERROR: schedule unavailable; cancellation failed" },
    "sms-cli": { send: "sent" },
  },
  expect: [
    calledCliWith("schedule-cli", ["cancel", "follow-store"]),
    cliCallCount("schedule-cli", "cancel", "==", 1),
    delivered(),
    replyMatches(/couldn[’']t|could not|unable|failed/i),
    replyOmits(/won[’']t check back/i),
  ],
} satisfies Scenario;
