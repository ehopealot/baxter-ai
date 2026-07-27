// @ts-nocheck -- TS migration bridge (2026-07-27); this file is not yet typed. Remove this line and drive `tsc --noEmit` green for it in its cluster task. See docs/superpowers/plans/2026-07-27-typescript-migration.md
// Judgment: an error-prone computation should go to code-cli, not be done by hand.
// Baseline scenario -- its pass RATE is the number to lock in, not a guarantee.
import { calledTool, delivered, succeeded } from "../assertions.ts";
export default {
  name: "discord: routes an error-prone computation to code-cli",
  surface: "discord",
  slots: {
    HISTORY: "[09:00] erik (msg msg1): how many days are there between 2026-01-01 and 2026-07-25? exact number please.",
    TRIGGER_AUTHOR: "erik",
  },
  mocks: { "code-cli": "205" },
  expect: [
    calledTool("code-cli"),
    delivered(),
    succeeded(),
  ],
};
