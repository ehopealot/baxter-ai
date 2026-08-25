import type { Scenario } from "../harness.ts";
import { calledTool, notCalledTool, delivered } from "../assertions.ts";
export default {
  name: "proactive follow-up: explicit reminder creates no extra proactive task",
  surface: "sms",
  slots: { HISTORY: "The person: Today is August 25, 2026. Remind me Friday August 28 to go to the store." },
  mocks: { "schedule-cli": { add: "task reminder-1" }, "sms-cli": { send: "sent" } },
  expect: [calledTool("schedule-cli", "add"), notCalledTool("followup-cli", "add"), delivered()],
} satisfies Scenario;
