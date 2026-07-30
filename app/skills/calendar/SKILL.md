---
name: calendar
description: Baxter's calendar with calendar-cli. Manage your OWN events (add/remove/list) and PUBLISH them as an ICS feed the family subscribes to; READ the family's shared calendar with poll + agenda. Times are ISO 8601. Publish after you change events; keep a recurring poll+publish task so the feed stays fresh.
allowed-tools: Bash(calendar-cli:*)
---

# Calendar with calendar-cli

You keep **your own** calendar of things you create (appointments you book, deadlines
you pull out of email) and **publish** it as an ICS feed the family subscribes to once
— so everything you add just appears on their phones. Separately you can **read** the
family's own calendar (they share it read-only) to know what's already on.

Your events are what you PUBLISH. The family's calendar you only READ.

## Manage your own events

| Command | What it does |
|---|---|
| `calendar-cli add --title T --start ISO [--end ISO] [--all-day] [--location L] [--desc D]` | Add an event. Prints its `uid`. `--start`/`--end` are ISO 8601: `YYYY-MM-DD` for `--all-day`, else a full datetime like `2026-08-04T15:00:00Z`. Resolve relative dates ("next Tuesday") to a real date yourself first. |
| `calendar-cli list` | Your events (uid, start, title). |
| `calendar-cli remove <uid>` | Delete one. |

## Publish (so the family sees your changes)

`calendar-cli publish` regenerates the ICS from your events and uploads it to the
subscribed feed. **Run it after you add or remove events.** (It needs the object-storage
feed provisioned — `calendar-keys.json`; if it's not set up yet it says so.)

Each event keeps a **stable UID**, so editing republishes in place rather than
duplicating on the family's phone.

## Read the family's calendar

| Command | What it does |
|---|---|
| `calendar-cli poll` | Fetch the family's shared feed(s) (`CALENDAR_FEED_URL`) into a local cache. |
| `calendar-cli agenda [--days N]` | Upcoming view over the next N days (default 7), merging **your** events and **theirs**, sorted; each line is tagged `[baxter]` (yours) or `[family]` (theirs). |

Use `agenda` to answer "what's on this week" or to check for conflicts before you book
something. `poll` first if you want it fresh.

## Keep the feed fresh — a recurring task

So the published feed and your view of the family's calendar stay current without you
thinking about it, schedule a repeating job once (see the schedule skill):

```
schedule-cli add "poll the family calendar and republish my feed (calendar-cli poll && calendar-cli publish)" --cron "0 * * * *"
```

Subscribed calendars only refresh every few hours, so hourly is plenty (and the
scheduler enforces a 60-minute minimum gap by default, so don't go tighter). If
`schedule-cli` isn't available in the run you're in (a fired heartbeat task can't
schedule), set this up from a chat or email run instead.

## Send your operator the subscribe link

When the feed is first set up (or if your operator asks for it), email them the
subscribe link with your **email CLI's `send-calendar`** command — one bare command
(`node <your mail CLI> send-calendar`). Recipient (your operator) and the entire
message are fixed/trusted; you only *trigger* it. It errors if the feed isn't
provisioned yet.

**Send it ONCE.** After you do, jot a line in your memory (e.g. "shared the calendar
subscribe link with the operator on <date>") so you don't email it again unsolicited on
a later run. Only resend if they ask or the link changes.

## Time-sensitive? Attach an .ics to your email

For something that needs to land NOW (a subscribed feed can lag hours), also **attach a
single-event calendar file** to your reply so they can tap "add to calendar" immediately:
`calendar-cli ics <uid>` prints a one-event ICS to stdout — save it and attach it.

## Notes

- All times are stored/compared in UTC; `add` a timed event with a `Z` (UTC) datetime,
  or convert the family's local time to UTC yourself.
- Recurring events on the family feed (weekly soccer, etc.) are expanded in `agenda` for
  simple weekly/daily/monthly repeats; an unusual repeat is shown once with a note —
  open the source feed if you need every occurrence.
