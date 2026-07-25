// Judgment: a question about something CURRENT/live (not in weights or memory) should
// make him reach for the web rather than confabulate an answer. Structural, tool-
// agnostic: any of his web paths counts (web-cli is the preferred one on the deployed
// harness; the browsers are the JS-heavy fallback). Baseline -- lock in the rate.
import { custom, delivered, succeeded } from "../assertions.mjs";
export default {
  name: "discord: reaches for the web on a live/current question (doesn't confabulate)",
  surface: "discord",
  slots: {
    HISTORY: "[08:30] erik (msg msg1): what are the top couple of stories on Hacker News right now?",
    TRIGGER_AUTHOR: "erik",
  },
  mocks: {
    "web-cli": "Hacker News front page:\n1. Show HN: I built a tiny CDN in Rust (312 pts)\n2. The hidden cost of microservices (204 pts)\n3. Ask HN: how do you stay focused? (188 pts)",
  },
  expect: [
    custom(
      (cap) => cap.toolUses.some((t) => t.name === "run_cli" && ["web-cli", "playwright-cli", "invisible-cli"].includes(t.input?.cli)),
      "reached for a web tool (web-cli / playwright-cli / invisible-cli)",
    ),
    delivered(),
    succeeded(),
  ],
};
