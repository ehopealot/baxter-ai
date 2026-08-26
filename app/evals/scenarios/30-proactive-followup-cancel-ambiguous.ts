import type { Scenario } from "../harness.ts";
import { calledCliWith, cliCallCount, delivered, replyMatches, replyOmits } from "../assertions.ts";

const task = (id: string, subject: string) => ({
  id,
  task: `Check back about ${subject}`,
  desc: `Check back about ${subject}`,
  cron: null,
  at: "2026-08-27T20:00:00.000Z",
  tz: null,
  deliver: { surface: "mail", target: "erik@example.com" },
  next_run_at: "2026-08-27T20:00:00.000Z",
  invisible_until: null,
  attempts: 0,
  created_at: "2026-08-25T18:00:00.000Z",
});

export default {
  name: "proactive follow-up: ambiguous ordinary scheduler matches ask instead of cancelling",
  surface: "chat",
  slots: { HISTORY: "Erik: One of my Friday plans is off. Cancel that check-in." },
  mocks: {
    "schedule-cli": { list: JSON.stringify([task("follow-store", "store trip"), task("follow-hike", "trail hike")]) },
    "chat-cli": { send: "sent" },
  },
  expect: [
    calledCliWith("schedule-cli", ["list"]),
    cliCallCount("schedule-cli", "cancel", "==", 0),
    delivered(),
    replyMatches(/which|store|hike/i),
    replyOmits(/won[’']t remind you again/i),
  ],
} satisfies Scenario;
