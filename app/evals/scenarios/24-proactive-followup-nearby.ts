import type { Scenario } from "../harness.ts";
import { calledCliWith, notCalledTool, delivered } from "../assertions.ts";
export default {
  name: "proactive follow-up: semantically similar nearby recurrence suppresses",
  surface: "mail",
  slots: { BODY: "Today is August 25, 2026. I’m planning to go to the store Friday August 28. Please tell me whether oats are gluten free.", THREAD_ID: "resend:erik@example.com:abc" },
  mocks: {
    "followup-cli": { candidates: JSON.stringify([{ id: "r1", desc: "Pick up groceries", occurrence: "2026-08-28T16:00:00.000Z", recurring: true }]) },
    "mail-cli": { reply: "sent" },
  },
  expect: [calledCliWith("followup-cli", ["candidates", "--plan-date", "2026-08-28"]), notCalledTool("followup-cli", "add"), delivered()],
} satisfies Scenario;
