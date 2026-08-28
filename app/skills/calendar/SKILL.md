---
name: calendar
description: Baxter's calendar with calendar-cli. Manage your own events (add/remove/list), read the family's shared calendar with poll + agenda, and create single-event ICS attachments. Times are ISO 8601.
allowed-tools: Bash(calendar-cli:*)
---

# Calendar with calendar-cli

You keep your own calendar of things you create (appointments you book, deadlines
you pull out of email). Those events appear in Baxter's Home calendar. Separately,
you can read the family's shared calendar (they share it read-only) to know what's
already on.

## Manage your own events

| Command | What it does |
|---|---|
| `calendar-cli add --title T --start ISO [--end ISO] [--all-day] [--location L] [--desc D]` | Add an event. Prints its `uid`. `--start`/`--end` are ISO 8601: `YYYY-MM-DD` for `--all-day`, else a full datetime like `2026-08-04T15:00:00Z`. Resolve relative dates ("next Tuesday") to a real date yourself first. |
| `calendar-cli list` | Your events (uid, start, title). |
| `calendar-cli remove <uid>` | Delete one. |

## Read the family's calendar

| Command | What it does |
|---|---|
| `calendar-cli poll` | Fetch the family's shared feed(s) (managed in the home settings UI, read from `calendar/feeds.json`) into a local cache. |
| `calendar-cli agenda [--days N]` | Upcoming view over the next N days (default 7), merging your events and the family's, sorted; each line is tagged `[baxter]` (yours) or `[family]` (theirs). |

Use `agenda` to answer "what's on this week" or to check for conflicts before you book
something. `poll` first if you want it fresh.

## Time-sensitive? Attach an .ics to your email

For something that needs to land now, attach a single-event calendar file to your
reply so the recipient can tap "add to calendar" immediately:
`calendar-cli ics <uid>` prints a one-event ICS to stdout — save it and attach it.

## Notes

- All times are stored/compared in UTC; `add` a timed event with a `Z` (UTC) datetime,
  or convert the family's local time to UTC yourself.
- Recurring events on the family feed (weekly soccer, etc.) are expanded in `agenda` for
  simple weekly/daily/monthly repeats; an unusual repeat is shown once with a note —
  open the source feed if you need every occurrence.
