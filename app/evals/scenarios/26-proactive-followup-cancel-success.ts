import type { Scenario } from "../harness.ts";
import { calledCliWith, cliCallCount, delivered, replyMatches } from "../assertions.ts";

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
  name: "proactive follow-up: ordinary scheduler cancellation claims success only after cancel succeeds",
  surface: "chat",
  slots: { HISTORY: "Erik: The store trip on Friday August 28 is off. Please cancel that check-in." },
  mocks: {
    "schedule-cli": { list: JSON.stringify([storeTask]), cancel: "cancelled follow-store" },
    "chat-cli": { send: "sent" },
  },
  expect: [
    calledCliWith("schedule-cli", ["list"]),
    calledCliWith("schedule-cli", ["cancel", "follow-store"]),
    cliCallCount("schedule-cli", "cancel", "==", 1),
    delivered(),
    replyMatches(/won[’']t remind you again/i),
  ],
} satisfies Scenario;
