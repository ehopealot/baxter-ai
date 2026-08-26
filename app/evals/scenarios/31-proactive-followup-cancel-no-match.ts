import type { Scenario } from "../harness.ts";
import { calledCliWith, cliCallCount, delivered, replyMatches, replyOmits } from "../assertions.ts";

export default {
  name: "proactive follow-up: no ordinary scheduler match never claims cancellation",
  surface: "sms",
  slots: { HISTORY: "The person: The Friday August 28 store trip is off. Cancel its check-in." },
  mocks: {
    "schedule-cli": { list: "[]" },
    "sms-cli": { send: "sent" },
  },
  expect: [
    calledCliWith("schedule-cli", ["list"]),
    cliCallCount("schedule-cli", "cancel", "==", 0),
    delivered(),
    replyMatches(/couldn[’']t find|could not find|don[’']t see|no (matching )?(task|reminder|check-in)/i),
    replyOmits(/won[’']t remind you again/i),
  ],
} satisfies Scenario;
