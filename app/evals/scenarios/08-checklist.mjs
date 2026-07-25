// Follow-through on a COMPOUND ask: one trigger bundles three sub-tasks, each needing
// a different tool. The failure mode this guards is a model that does the first item
// (or the easy/last one) and silently drops the rest -- so every checklist item is its
// own structural assertion, and the scenario passes only when he checks off ALL of
// them. A prompt/skill change that makes him start dropping sub-tasks shows up as a
// pass-rate drop here.
import { calledTool, delivered, succeeded } from "../assertions.mjs";
export default {
  name: "discord: completes every item of a 3-part checklist task",
  surface: "discord",
  slots: {
    HISTORY:
      "[09:00] erik (msg msg1): three things please — (1) work out the EXACT number of days " +
      "between 2026-01-01 and 2026-12-25, (2) start a project note called 'xmas-countdown' " +
      "recording that number, and (3) tell me the answer here.",
    TRIGGER_AUTHOR: "erik",
  },
  mocks: { "code-cli": "358" },
  expect: [
    calledTool("code-cli"),      // item 1: computed it (didn't count by hand)
    calledTool("projects-cli"),  // item 2: opened/created the project note
    delivered(),                 // item 3: actually answered in-channel
    succeeded(),
  ],
};
