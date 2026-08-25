import type { Scenario } from "../harness.ts";
import { calledTool, delivered, replyOmits } from "../assertions.ts";
export default {
  name: "proactive follow-up: failed creation never claims check-in success",
  surface: "sms",
  slots: { HISTORY: "The person: Today is August 25, 2026. I’m planning to go to the store Friday August 28. What should I buy for tacos?" },
  mocks: {
    "followup-cli": { candidates: "[]", add: "ERROR: schedule unavailable; no follow-up was created" },
    "sms-cli": { send: "sent" },
  },
  expect: [calledTool("followup-cli", "add"), delivered(), replyOmits(/I[’']ll check back in about/i)],
} satisfies Scenario;
