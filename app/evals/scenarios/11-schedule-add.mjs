// A recurring reminder request -> he sets it up via schedule-cli add (he can only
// add/cancel/list; a dedicated driver fires it). Asserts the add AND the confirmation
// back to the channel. discord/mail get schedule-cli; heartbeat deliberately does not.
import { calledTool, delivered, succeeded } from "../assertions.mjs";
export default {
  name: "discord: sets up a recurring reminder via schedule-cli add",
  surface: "discord",
  slots: {
    HISTORY: "[07:45] erik (msg msg1): can you post a good-morning message to this channel every day at 9am my time (US Pacific)?",
    TRIGGER_AUTHOR: "erik",
  },
  mocks: {
    "schedule-cli": {
      add: "Scheduled task t_9f2a (cron '0 9 * * *', America/Los_Angeles). Next run: 2026-07-27 09:00 PDT.",
      "*": "",
    },
  },
  expect: [
    calledTool("schedule-cli", "add"),
    delivered(),   // confirmed back to erik
    succeeded(),
  ],
};
