# Proactive follow-ups

(part of Baxter — see [architecture map](../../CLAUDE.md))

Mail, direct/group SMS, and Home Chat may create a proactive ordinary scheduled task only for a **specific, concrete matter** that was discussed and merits a later check-in. It is deliberately never the default after an interaction. A follow-up is either `date` (the existing concrete-day behavior) or `topic` (an unresolved discussion topic). Explicit reminders remain ordinary `schedule-cli` tasks.

## Creation and limits

`followup-cli` accepts exactly one form:

```text
followup-cli add "<subject>" --plan-date YYYY-MM-DD
followup-cli add "<subject>" --topic
```

The supported daemon supplies the admitted delivery surface and target in the run environment. The SMS daemon canonicalizes direct targets and validates strict group targets before supplying that capability; the CLI revalidates those boundaries before persistence.

Both kinds are normal one-shot scheduler records with the trusted `follow_up: {kind, subject}` metadata required for caps and safe prompt context. A date follow-up retains its existing choice of follow-up *day*; a topic follow-up selects two household-local civil days after creation. Every follow-up runs at a randomized household-local time from **13:00–15:59**. There may be at most **three pending follow-ups** and at most **one follow-up per household-local civil day**. A collision moves the new task to the next free day, except an incoming date follow-up displaces an already-scheduled topic follow-up to its next free day. Date follow-ups therefore take priority over topics.

The scheduler record keeps its normal task, description, delivery, claim, retry, and give-up semantics. The CLI neither accepts a model-supplied route/timezone nor introduces an alternate delivery path.

## Prompt context and cancellation

Every normal agent prompt (mail, SMS, Home Chat, Discord message/reaction, heartbeat, TUI, and voice dispatch) receives a small fail-closed list of pending records: validated id, kind, ISO due instant, and normalized subject. It never includes route targets or arbitrary task text. The guidance says to compare every later discussion to this list and cancel a matching follow-up whenever it **may** already be resolved: Baxter should err toward cancellation rather than sending an unnecessary check-in. Cancellation remains `schedule-cli cancel <id>` and is acknowledged only after that command succeeds. No surface gains `followup-cli` creation authority beyond mail/SMS/Home Chat.

## Monday and Friday daily updates

On Monday and Friday, the morning check-in folds a pending follow-up due later that same day into the daily update for its matching direct mail/SMS recipient. After a successful delivery to that recipient, the handler removes only the folded records under the scheduler lock, so they do not fire again at 13:00–15:59. SMS-group follow-ups are never folded because the household daily update has no equivalent group delivery; they remain normal scheduled tasks.
