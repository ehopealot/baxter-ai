// Workspace discovery: a fact that lives in some saved file (not the injected memory)
// should make him search his own workspace with files-cli (his only ls/grep -- bare
// shell isn't granted), rather than claim he can't find it. Baseline; rate to lock in.
import { calledTool, delivered, succeeded } from "../assertions.mjs";
export default {
  name: "discord: searches its workspace with files-cli to find a saved fact",
  surface: "discord",
  seed: {
    memory: "## People\n- **erik** — the operator.\n",
  },
  slots: {
    HISTORY: "[15:05] erik (msg msg1): dig through your saved notes — do you have my flight confirmation number anywhere?",
    TRIGGER_AUTHOR: "erik",
  },
  mocks: {
    "files-cli": {
      grep: "notes/travel.md:3: Flight AA123 SFO->JFK 2026-08-10, confirmation ZX9QWP",
      list: "memory.md (128)\nnotes/travel.md (512)",
      "*": "",
    },
  },
  expect: [
    calledTool("files-cli"),
    delivered(),
    succeeded(),
  ],
};
