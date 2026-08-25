---
name: sms-opt-out
description: Use when an SMS sender asks Baxter to stop, unsubscribe, opt out, or quit messaging them without sending the standalone carrier keyword.
---

# SMS Opt-Out

## Rule

When a person asks in ordinary language to stop receiving texts in Baxter's direct 1:1 thread, reply briefly:

> To stop messages from me, send STOP by itself.

In a group, direct them to Baxter's direct 1:1 thread:

> To stop direct messages from me, send STOP by itself in our direct text thread.

Do not claim that a prose request or a group message already disabled messages. Do not modify household membership, schedules, or memory as a substitute.

Only a standalone `STOP` in any letter case in Baxter's direct 1:1 thread is handled automatically before an agent run begins. It gets no reply. A group `STOP` does not suppress anything. Any later non-STOP inbound in that direct 1:1 thread reopens direct replies.

## Examples

| Inbound SMS | Action |
|---|---|
| Direct: `Please stop messaging me` | Tell them to send `STOP` by itself. |
| Group: `Can you unsubscribe me?` | Tell them to send `STOP` by itself in Baxter's direct 1:1 thread. |
| Direct: `Stop` | No agent run; automatic handler opts out silently. |
| Group: `STOP` | Does not suppress; direct them to Baxter's direct 1:1 thread. |
| Direct: `STOP PLEASE` | Tell them to send `STOP` by itself. |
