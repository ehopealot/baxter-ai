---
name: sms-opt-out
description: Use when an SMS sender asks Baxter to stop, unsubscribe, opt out, or quit messaging them without sending the standalone carrier keyword.
---

# SMS Opt-Out

## Rule

When a person asks in ordinary language to stop receiving texts, reply briefly:

> To stop messages from me, send STOP by itself.

Do not claim that their request already disabled messages. Do not modify household membership, schedules, or memory as a substitute.

A standalone `STOP` in any letter case is handled automatically before an agent run begins, so it does not need a reply. Any later inbound message reopens replies.

## Examples

| Inbound SMS | Action |
|---|---|
| `Please stop messaging me` | Tell them to send `STOP` by itself. |
| `Can you unsubscribe me?` | Tell them to send `STOP` by itself. |
| `Stop` | No agent run; automatic handler opts out silently. |
| `STOP PLEASE` | Tell them to send `STOP` by itself. |
