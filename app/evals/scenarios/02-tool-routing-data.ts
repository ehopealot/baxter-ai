// @ts-nocheck -- TS migration bridge (2026-07-27); this file is not yet typed. Remove this line and drive `tsc --noEmit` green for it in its cluster task. See docs/superpowers/plans/2026-07-27-typescript-migration.md
// Judgment: a sports-score query should route to data-cli (the preferred source),
// not scrape the web. Its pass RATE is a behavioral baseline to lock in.
import { delivered, calledTool, notCalledTool, succeeded } from "../assertions.ts";
export default {
  name: "discord: routes a sports-score query to data-cli (not web-cli)",
  surface: "discord",
  slots: {
    HISTORY: "[10:00] erik (msg msg1): what was the final score of the last 49ers game?",
    TRIGGER_AUTHOR: "erik",
  },
  mocks: {
    "data-cli": '{"events":[{"shortName":"SF 24, LAR 17","status":"STATUS_FINAL"}]}',
  },
  expect: [
    calledTool("data-cli"),
    notCalledTool("web-cli"),
    delivered(),
    succeeded(),
  ],
};
