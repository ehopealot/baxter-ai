// @ts-nocheck -- TS migration bridge (2026-07-27); this file is not yet typed. Remove this line and drive `tsc --noEmit` green for it in its cluster task. See docs/superpowers/plans/2026-07-27-typescript-migration.md
// Judgment: a geocoding / place-lookup question should route to data-cli (nominatim,
// the preferred source) rather than scraping the open web -- the geocoding twin of the
// sports-score routing baseline (02). Its pass RATE is the number to lock in.
import { calledTool, notCalledTool, delivered, succeeded } from "../assertions.ts";
export default {
  name: "discord: routes a geocoding question to data-cli (not web-cli)",
  surface: "discord",
  slots: {
    HISTORY: "[11:15] erik (msg msg1): what are the latitude/longitude coordinates of the Eiffel Tower?",
    TRIGGER_AUTHOR: "erik",
  },
  mocks: {
    "data-cli": '[{"lat":"48.8582602","lon":"2.2944991","display_name":"Eiffel Tower, Paris, France"}]',
  },
  expect: [
    calledTool("data-cli"),
    notCalledTool("web-cli"),
    delivered(),
    succeeded(),
  ],
};
