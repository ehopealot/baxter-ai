// The most basic loop: a plain question -> he sends ONE reply and stops. This is
// the canary; if it fails, the harness (or his core reply behavior) is broken.
import { delivered, calledTool, toolCallCount, succeeded } from "../assertions.ts";
export default {
  name: "discord: replies once to a simple question",
  surface: "discord",
  slots: {
    HISTORY: "[10:00] erik (msg msg1): hey Baxter, quick one -- what's the capital of France?",
    TRIGGER_AUTHOR: "erik",
  },
  expect: [
    delivered(),                         // actually sent something
    calledTool("discord-cli", "reply"),  // as a reply to the trigger
    toolCallCount("<=", 8),              // didn't spiral
    succeeded(),                          // finished cleanly
  ],
};
