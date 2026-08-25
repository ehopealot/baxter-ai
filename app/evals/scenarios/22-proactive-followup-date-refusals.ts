import type { Scenario } from "../harness.ts";
import { notCalledTool, delivered } from "../assertions.ts";
export default {
  name: "proactive follow-up: today past ambiguous and impossible dates are refused",
  surface: "sms",
  slots: { HISTORY: "The person: Today is August 25, 2026. Maybe I’ll hike today, or on February 29 next year, or sometime later. What weather gear should I bring?" },
  mocks: { "sms-cli": { send: "sent" } },
  expect: [notCalledTool("followup-cli", "add"), delivered()],
} satisfies Scenario;
