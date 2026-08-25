import type { Scenario } from "../harness.ts";
import { calledCliWith, delivered, replyMatches } from "../assertions.ts";
export default {
  name: "proactive follow-up: send-first cancellation uses may-already-be-on-way wording",
  surface: "mail",
  slots: { BODY: "The Friday store trip is off. Cancel its proactive check-in.", THREAD_ID: "resend:erik@example.com:abc" },
  mocks: {
    "followup-cli": { list: JSON.stringify([{ id: "follow-store", subject: "store trip", plan_date: "2026-08-28", next_run_at: "2026-08-27T20:00:00.000Z", origin: { surface: "sms" }, desc: "Check back about store trip" }]) },
    "schedule-cli": { cancel: "cancelled follow-store -- send_already_started" }, "mail-cli": { reply: "sent" },
  },
  expect: [calledCliWith("schedule-cli", ["cancel", "follow-store"]), delivered(), replyMatches(/may already be on the way/i)],
} satisfies Scenario;
