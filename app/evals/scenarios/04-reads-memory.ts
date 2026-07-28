// Memory discipline: a question whose answer is only in seeded memory -> he reads
// the memory file and uses the fact. Asserts both the read AND that it surfaced.
import type { Scenario } from "../harness.ts";
import { calledTool, delivered, replyMatches, succeeded } from "../assertions.ts";
export default {
  name: "discord: reads memory and uses a seeded fact",
  surface: "discord",
  seed: { memory: "## People\n- **erik** — the operator. His dog is named **Biscuit** (a corgi).\n" },
  slots: {
    HISTORY: "[09:00] erik (msg msg1): hey remind me — what's my dog's name?",
    TRIGGER_AUTHOR: "erik",
  },
  expect: [
    calledTool("read_file"),      // he opened his memory
    delivered(),
    replyMatches(/biscuit/i),      // and answered from it
    succeeded(),
  ],
} satisfies Scenario;
