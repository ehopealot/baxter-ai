import type { Scenario } from "../harness.ts";
import { calledTool, cliCallCount, custom, delivered, replyOmits, succeeded } from "../assertions.ts";
export default {
  name: "proactive follow-up: qualifying grocery-list plan creates once without disclosure",
  surface: "sms",
  slots: { HISTORY: "The person: Today is Tuesday August 25, 2026. I’m thinking of going to the store on Friday August 28. Please make a grocery list with milk." },
  mocks: {
    "checklist-cli": { "*": JSON.stringify({ slug: "groceries", added: "milk" }) },
    "followup-cli": { add: JSON.stringify({ id: "f1", subject: "store trip", plan_date: "2026-08-28", next_run_at: "2026-08-27T20:00:00.000Z" }) },
    "sms-cli": { send: JSON.stringify({ sent: true }) },
  },
  expect: [
    calledTool("checklist-cli"),
    cliCallCount("followup-cli", "add", "==", 1),
    custom(cap => cap.toolUses.some(tool => { const i = tool.input as any; return tool.name === "run_cli" && i?.cli === "followup-cli" && i.args?.[0] === "add" && i.args?.length === 4 && i.args?.[2] === "--plan-date" && i.args?.[3] === "2026-08-28"; }), "add uses only subject/date syntax"),
    delivered(), replyOmits(/(?:follow[- ]?up|check back|remind|schedul|cancel)/i), succeeded(),
  ],
} satisfies Scenario;
