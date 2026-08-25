import type { Scenario } from "../harness.ts";
import { calledCliWith, cliCallCount, delivered, replyMatches } from "../assertions.ts";
export default {
  name: "proactive follow-up: distant or unrelated candidates do not suppress",
  surface: "sms",
  slots: { HISTORY: "The person: Today is August 25, 2026. I’m planning to go to the store Friday August 28. Also, what is a good milk substitute?" },
  mocks: {
    "followup-cli": { candidates: JSON.stringify([{ id: "u1", desc: "Water the garden", occurrence: "2026-08-28T17:00:00.000Z", recurring: true }]), add: JSON.stringify({ id: "f2", subject: "store trip", plan_date: "2026-08-28", next_run_at: "2026-08-27T20:00:00.000Z" }) },
    "sms-cli": { send: "sent" },
  },
  expect: [calledCliWith("followup-cli", ["candidates", "--plan-date", "2026-08-28"]), cliCallCount("followup-cli", "add", "==", 1), delivered(), replyMatches(/I[’']ll check back in about/i)],
} satisfies Scenario;
