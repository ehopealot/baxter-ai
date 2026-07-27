// @ts-nocheck -- TS migration bridge (2026-07-27); this file is not yet typed. Remove this line and drive `tsc --noEmit` green for it in its cluster task. See docs/superpowers/plans/2026-07-27-typescript-migration.md
// Memory discipline: a question whose answer is only in seeded memory -> he reads
// the memory file and uses the fact. Asserts both the read AND that it surfaced.
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
};
