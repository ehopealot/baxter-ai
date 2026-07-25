// MAIL surface + schedule-cli read: "what have you got scheduled?" -> he lists the
// live schedule (it isn't injected into the prompt, so he must call it) and reports
// back by email. Also exercises the mail surface's schedule-cli grant.
import { calledTool, delivered, succeeded } from "../assertions.mjs";
export default {
  name: "mail: lists scheduled tasks via schedule-cli list",
  surface: "mail",
  slots: {
    FROM: "Erik <erik@example.com>",
    SUBJECT: "my reminders",
    BODY: "Hey Baxter — can you remind me what reminders/scheduled jobs you currently have set for me?",
    MESSAGE_ID: "<sched1@example.com>",
  },
  mocks: {
    "schedule-cli": {
      list: "1. t_9f2a — cron '0 9 * * *' (America/Los_Angeles) — next 2026-07-27 09:00 — 'good morning to #general'\n2. t_c1d4 — one-shot 2026-08-01 12:00 — 'wish Maya happy birthday'",
      "*": "",
    },
  },
  expect: [
    calledTool("schedule-cli", "list"),
    calledTool("mail", "reply"),
    delivered(),
    succeeded(),
  ],
};
