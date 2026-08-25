import type { Scenario } from "../harness.ts";
import { calledCliWith, cliCallCount, delivered, replyMatches } from "../assertions.ts";
export default {
  name: "proactive follow-up: clear cross-surface cancellation removes one matching id",
  surface: "chat",
  slots: { HISTORY: "Erik: The store trip on Friday August 28 is off. Please cancel that check-in." },
  mocks: {
    "followup-cli": { list: JSON.stringify([{ id: "follow-store", subject: "store trip", plan_date: "2026-08-28", next_run_at: "2026-08-27T20:00:00.000Z", origin: { surface: "sms" }, desc: "Check back about store trip" }]) },
    "schedule-cli": { cancel: "cancelled follow-store" }, "chat-cli": { send: "sent" },
  },
  expect: [calledCliWith("followup-cli", ["list"]), calledCliWith("schedule-cli", ["cancel", "follow-store"]), cliCallCount("schedule-cli", "cancel", "==", 1), delivered(), replyMatches(/won[’']t check back/i)],
} satisfies Scenario;
