// Heartbeat end-to-end WITH research: a fired task that has to fetch something live and
// then deliver it to Discord. Exercises the heartbeat surface's web + discord grants
// and the deliver-to-a-channel path (a send, not a reply -- there's no trigger message).
import type { Scenario } from "../harness.ts";
import { custom, calledTool, delivered, succeeded } from "../assertions.ts";
export default {
  name: "heartbeat: fetches a live page and delivers a summary to Discord",
  surface: "heartbeat",
  slots: {
    TASK: "Fetch the current front page of Hacker News (https://news.ycombinator.com) and post its single top story as a one-line message to Discord channel chan1.",
  },
  mocks: {
    "web-cli": "Hacker News front page:\n1. Show HN: I built a tiny CDN in Rust (312 pts)\n2. The hidden cost of microservices (204 pts)",
  },
  expect: [
    custom(
      (cap) => cap.toolUses.some((t) => t.name === "run_cli" && ["web-cli", "playwright-cli", "invisible-cli"].includes((t.input as { cli?: string } | undefined)?.cli ?? "")),
      "fetched via a web tool (web-cli / playwright-cli / invisible-cli)",
    ),
    calledTool("discord-cli", "send"),  // delivered to the channel (no trigger to reply to)
    delivered(),
    succeeded(),
  ],
} satisfies Scenario;
