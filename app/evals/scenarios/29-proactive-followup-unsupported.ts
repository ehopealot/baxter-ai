import type { Scenario } from "../harness.ts";
import { notCalledTool, delivered, replyOmits } from "../assertions.ts";
export default {
  name: "proactive follow-up: unsupported Discord surface neither advertises nor invokes capability",
  surface: "discord",
  slots: { HISTORY: "[10:00] erik (msg msg1): Today is August 25, 2026. I’m planning to go to the store Friday August 28. Say hello.", TRIGGER_AUTHOR: "erik" },
  mocks: { "discord-cli": { reply: "sent" } },
  expect: [notCalledTool("followup-cli"), delivered(), replyOmits(/I[’']ll check back in about/i)],
} satisfies Scenario;
