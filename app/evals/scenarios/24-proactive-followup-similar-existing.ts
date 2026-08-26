import type { Scenario } from "../harness.ts";
import { calledCliWith, cliCallCount, delivered } from "../assertions.ts";

const groceryTask = {
  id: "grocery-reminder",
  task: "Check back about buying groceries",
  desc: "Check back about buying groceries",
  cron: null,
  at: "2026-08-27T20:00:00.000Z",
  tz: null,
  deliver: { surface: "mail", target: "erik@example.com" },
  next_run_at: "2026-08-27T20:00:00.000Z",
  invisible_until: null,
  attempts: 0,
  created_at: "2026-08-25T18:00:00.000Z",
};

export default {
  name: "proactive follow-up: similar ordinary scheduled task suppresses creation",
  surface: "mail",
  slots: {
    BODY: "Today is August 25, 2026. I’m planning to go to the store Friday August 28. Please tell me whether oats are gluten free.",
    THREAD_ID: "resend:erik@example.com:abc",
  },
  mocks: {
    "schedule-cli": { list: JSON.stringify([groceryTask]) },
    "mail-cli": { reply: "sent" },
  },
  expect: [
    calledCliWith("schedule-cli", ["list"]),
    cliCallCount("followup-cli", "add", "==", 0),
    delivered(),
  ],
} satisfies Scenario;
