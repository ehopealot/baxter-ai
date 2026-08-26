import type { Scenario } from "../harness.ts";
import { calledCliWith, cliCallCount, delivered, replyOmits } from "../assertions.ts";

export default {
  name: "proactive follow-up: failed ordinary-task creation never claims success",
  surface: "sms",
  slots: {
    HISTORY: "The person: Today is August 25, 2026. I’m planning to go to the store Friday August 28. What should I buy for tacos?",
  },
  mocks: {
    "schedule-cli": { list: "[]" },
    "followup-cli": { add: "ERROR: schedule unavailable; no follow-up was created" },
    "sms-cli": { send: "sent" },
  },
  expect: [
    calledCliWith("schedule-cli", ["list"]),
    cliCallCount("followup-cli", "add", "==", 1),
    delivered(),
    replyOmits(/I[’']ll check back in about/i),
  ],
} satisfies Scenario;
