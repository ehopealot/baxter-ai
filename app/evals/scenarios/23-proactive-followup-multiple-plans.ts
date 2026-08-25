import type { Scenario } from "../harness.ts";
import { notCalledTool, delivered } from "../assertions.ts";
export default {
  name: "proactive follow-up: multiple independently qualifying plans create none",
  surface: "chat",
  slots: { HISTORY: "Erik: Today is August 25, 2026. I’m planning to visit Maya on Friday August 28, and independently planning a beach trip Saturday August 29. Say hi back." },
  mocks: { "chat-cli": { send: "sent" } },
  expect: [notCalledTool("followup-cli", "add"), delivered()],
} satisfies Scenario;
