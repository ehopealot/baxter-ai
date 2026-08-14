---
name: checklist
description: Checkable-item lists with checklist-cli -- groceries, packing, todos, "before the trip". Items get checked off, then cleared. Use this (NOT projects-cli) for anything where each entry can be marked done. `find` resolves a natural "I did X" message to the item and you check it off; --due schedules a reminder.
allowed-tools: Bash(checklist-cli:*)
---

# Checkable-item lists with checklist-cli

`checklist-cli` is for **lists of things that get done and then cleared** — a grocery
list, a packing list, "errands this weekend", a todo list. Each item is checked off when
complete.

**Checklist vs project — the line:** *can each entry be checked off as done?* → it's a
**checklist**. Is it a page of notes/context you keep adding to, that never gets "done"? →
that's a **project** (`projects-cli`). Milk, "call the plumber", "pack sunscreen" are
checklist items; "everything about the kitchen reno" is a project.

## Commands

| Command | What it does |
|---|---|
| `checklist-cli lists` | Every checklist: name, open/total counts. |
| `checklist-cli make <name> [--channel <id>]` | Start a checklist. |
| `checklist-cli show <name> [--open]` | Its items, `[ ]` / `[x]`. `--open` hides the checked-off ones — use it for "what's left?", plain `show` for the whole list. |
| `checklist-cli add <name> <item…> [--due <ISO>]` | Add an open item. |
| `checklist-cli check <name> <item…>` / `uncheck` | Mark it done / not done (fuzzy match within the list). |
| `checklist-cli remove <name> <item…>` | Delete an item. |
| `checklist-cli clear <name> [--all]` | Drop the **checked** items (bare `clear`); `--all` empties the whole list. |
| `checklist-cli rm <name>` | Delete a checklist. |
| `checklist-cli find <phrase…> [--list <name>] [--include-checked]` | Ranked items matching a phrase; open by default, `--include-checked` adds done items. |

List and item names are matched fuzzily, so `check groceries milk` works. Names slugify
(`packing-list`); `lists` shows the slug. If a check is ambiguous ("milk" when both "2%
milk" and "whole milk" are open) it errors — be more specific.

## "I did X" → check it off

When someone just says they finished/got/did something ("got the milk", "finished the
taxes", "picked up the dry cleaning"), **resolve it to a list item and check it off**:

1. `checklist-cli find "<what they said>"` — ranked open matches, each with its list.
2. If there's **one clear match**, `check <list> <item>` it and say so.
3. If good matches are on **more than one list** (milk open on both `groceries` and
   `costco-run`), **ask which list** rather than guessing.
4. If nothing scores well, it's not a list item — don't force it.

Never silently check something on a weak match.

## "What list was X on?" → reverse-lookup

When the caller asks about an item by text and you DON'T know whether it's open or
already done (e.g. "where was the dentist appointment?", "did we already pay the
electric bill?"), use `find` with `--include-checked`:

```
checklist-cli find "<phrase>" --include-checked
```

This returns ranked open AND checked items, each tagged with the list that contains it
and a `✓` for already-done ones. Same score floor and ranking as the open-only path,
so a clear winner is unambiguous; tie or low score means you should `show` the list
yourself rather than guess.

## Mirror a checklist to a Discord channel

`checklist-cli make <name> --channel <channelId>` binds a checklist to a Discord channel
at creation. Baxter's gateway then keeps that channel in sync:
each **open** item shows as its own message, and **reacting ✅ on an item's message checks
it off** — the message stays but is struck through (`~~item~~ ✅`), so the channel keeps a
record of what's done. Adding an item posts it; checking/unchecking it (from anywhere —
email, another channel, the CLI) re-renders its message struck/plain; **removing** it (or
`clear`/`rm`) deletes the message. You don't post or edit those
messages yourself — the gateway reconciles them; just `add`/`check`/`remove` as usual and
the channel follows. Good for a shared household todo channel where either parent can tick
things off with a tap.

## Due dates → reminders

Adding an item with `--due <ISO>` records when it's due. To actually get reminded, also
**schedule a self-cancelling reminder** (see the schedule skill):

```
checklist-cli add errands "renew the car registration" --due 2026-08-15T09:00:00Z
schedule-cli add "if 'renew the car registration' is still open on the errands checklist (checklist-cli find), remind about it; otherwise do nothing" --desc "Car registration reminder" --at 2026-08-15T09:00:00Z --email <operator>
```

Phrase the scheduled task to **check the item's still open first** (`checklist-cli find` /
`show`) and only ping if it is — so finishing early quietly cancels the nag, and a removed
item is moot too. (`schedule-cli` isn't available in every run — set the reminder from a
chat/email run, not a fired heartbeat task.)

## Keep them tidy

Once items are done, `clear <name>` drops the checked ones so the list stays the *open*
work. Delete a whole list with `rm` when the trip's over.
