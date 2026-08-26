import type { Scenario } from "../harness.ts";
import { calledCliWith, cliCallCount, delivered, replyMatches } from "../assertions.ts";

const gardenTask = {
  id: "garden-reminder",
  task: "Water the garden",
  desc: "Water the garden",
  cron: "0 17 * * *",
  at: null,
  tz: "America/New_York",
  deliver: { surface: "sms", target: "+15551234567" },
  next_run_at: "2026-08-28T21:00:00.000Z",
  invisible_until: null,
  attempts: 0,
  created_at: "2026-08-20T18:00:00.000Z",
};

export default {
  name: "proactive follow-up: unrelated ordinary scheduled task does not suppress creation",
  surface: "sms",
  slots: {
    HISTORY: "The person: Today is August 25, 2026. I’m planning to go to the store Friday August 28. Also, what is a good milk substitute?",
  },
  mocks: {
    "schedule-cli": { list: JSON.stringify([gardenTask]) },
    "followup-cli": { add: JSON.stringify({ id: "f2", subject: "store trip", plan_date: "2026-08-28", next_run_at: "2026-08-27T20:00:00.000Z" }) },
    "sms-cli": { send: "sent" },
  },
  expect: [
    calledCliWith("schedule-cli", ["list"]),
    cliCallCount("followup-cli", "add", "==", 1),
    delivered(),
    replyMatches(/I[’']ll check back in about/i),
  ],
} satisfies Scenario;
