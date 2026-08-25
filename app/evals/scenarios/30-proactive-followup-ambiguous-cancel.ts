import type { Scenario } from "../harness.ts";
import { calledCliWith, cliCallCount, delivered, replyMatches } from "../assertions.ts";

export default {
  name: "proactive follow-up: ambiguous cancellation asks instead of cancelling broadly",
  surface: "chat",
  slots: { HISTORY: "Erik: One of my Friday plans is off. Cancel that check-in." },
  mocks: {
    "followup-cli": { list: JSON.stringify([
      { id: "follow-store", subject: "store trip", plan_date: "2026-08-28", next_run_at: "2026-08-27T20:00:00.000Z", origin: { surface: "sms" }, desc: "Check back about store trip" },
      { id: "follow-hike", subject: "trail hike", plan_date: "2026-08-28", next_run_at: "2026-08-27T21:00:00.000Z", origin: { surface: "mail-thread" }, desc: "Check back about trail hike" },
    ]) },
    "chat-cli": { send: "sent" },
  },
  expect: [calledCliWith("followup-cli", ["list"]), cliCallCount("schedule-cli", "cancel", "==", 0), delivered(), replyMatches(/which|store|hike/i)],
} satisfies Scenario;
