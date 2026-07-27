// Projects memory: the preamble injects only project SLUGS + dates (deliberately not
// bodies), so a question about a project's STATUS forces an open. Asserts he opens the
// right note and answers from it -- the cross-surface project-context path.
import { calledTool, delivered, succeeded } from "../assertions.ts";
export default {
  name: "discord: opens an existing project note to answer a status question",
  surface: "discord",
  slots: {
    PROJECTS_LIST: "- kitchen-remodel (updated 2026-07-24)\n- q3-budget (updated 2026-07-19)",
    HISTORY: "[13:20] erik (msg msg1): where are we on the kitchen remodel? what's the next step?",
    TRIGGER_AUTHOR: "erik",
  },
  mocks: {
    "projects-cli": {
      open: "# Kitchen Remodel\n\nStatus: waiting on the contractor's revised quote (expected this week).\nBudget: $22k.\nNext step: pick the backsplash tile before the quote lands.\n",
      "*": "",
    },
  },
  expect: [
    calledTool("projects-cli", "open"),
    delivered(),
    succeeded(),
  ],
};
