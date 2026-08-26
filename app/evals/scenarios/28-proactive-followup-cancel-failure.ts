import type { Scenario } from "../harness.ts";
import { calledCliWith, cliCallCount, delivered, replyMatches, replyOmits } from "../assertions.ts";

const storeTask = {
  id: "follow-store",
  task: "Check back about store trip",
  desc: "Check back about store trip",
  cron: null,
  at: "2026-08-27T20:00:00.000Z",
  tz: null,
  deliver: { surface: "sms", target: "+15551234567" },
  next_run_at: "2026-08-27T20:00:00.000Z",
  invisible_until: null,
  attempts: 0,
  created_at: "2026-08-25T18:00:00.000Z",
};

export default {
  name: "proactive follow-up: failed ordinary scheduler cancellation never claims success",
  surface: "sms",
  slots: { HISTORY: "The person: The Friday August 28 store trip is off. Cancel its check-in." },
  mocks: {
    "schedule-cli": {
      list: JSON.stringify([storeTask]),
      cancel: "ERROR: schedule unavailable; cancellation failed",
    },
    "sms-cli": { send: "sent" },
  },
  expect: [
    calledCliWith("schedule-cli", ["list"]),
    calledCliWith("schedule-cli", ["cancel", "follow-store"]),
    cliCallCount("schedule-cli", "cancel", "==", 1),
    delivered(),
    replyMatches(/couldn[’']t|could not|unable|failed/i),
    replyOmits(/won[’']t remind you again/i),
  ],
} satisfies Scenario;
