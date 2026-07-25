// Skill discovery: "is there a skill for X?" -> he searches the ecosystem with
// skills-cli find and SUGGESTS one. There is deliberately no install verb (installing
// is the operator's host-side call), so this also guards that he recommends rather than
// pretends to install. Baseline; lock in the rate.
import { calledTool, delivered, succeeded } from "../assertions.mjs";
export default {
  name: "discord: searches the skill ecosystem with skills-cli find and recommends",
  surface: "discord",
  slots: {
    HISTORY: "[16:40] erik (msg msg1): is there an existing agent skill for working with Notion? if so, tell me how I'd add it.",
    TRIGGER_AUTHOR: "erik",
  },
  mocks: {
    "skills-cli": {
      find: '[{"slug":"notion","name":"Notion","installs":1240,"owner":"acme-labs","repo":"notion-skill","url":"https://github.com/acme-labs/notion-skill","installCommand":"npx skills add acme-labs/notion-skill@notion","trusted":false}]',
      "*": "",
    },
  },
  expect: [
    calledTool("skills-cli", "find"),
    delivered(),
    succeeded(),
  ],
};
