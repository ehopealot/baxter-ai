# checklist-cli — checkable-item lists (design)

**Status:** approved-to-build (reviewer + operator vet this spec). **Goal:** give Baxter
`checklist-cli`, a tool for **checkable/completable lists** (groceries, packing, todos,
"before the trip") — items get checked off and then cleared. Distinct from `projects-cli`
(aggregating notes/context that never get "done"). Part of the family-ops service; the
family-facing tap-to-check web page is a baxter-control follow-up.

## The projects vs checklists boundary

The load-bearing distinction, to be stated in BOTH skills so the model routes correctly:

- **Checklist** = a set of items you **complete and then clear** (check off milk; finish
  "call the plumber"). Ephemeral, item-level state.
- **Project** = **aggregating** context for an ongoing effort (the kitchen-reno page).
  Nothing gets "done"; it's a living document.

Rule of thumb the skills give the model: *"Can each entry be checked off as done? →
checklist. Is it a page of notes you keep adding to? → project."*

## Scope

- **In (core, this build):** `checklist-cli` + a self-contained STATE_DIR store + the three
  todo powers (due reminders, one-way Discord mirror, two-way complete-from-channel) + the
  natural-language `find` resolver + prompt/skill wiring.
- **Deferred (baxter-control follow-up):** the family web app — one home page per family,
  per-list pages, **tap-to-check that syncs across both parents' phones**, magic-code auth.
  The self-contained store publishes a read view later (like the calendar feed).

## Data model

`STATE_DIR/checklists/checklists.json` — in `STATE_DIR` (NOT `MEMORY_DIR`), so
`checklist-cli` is the only writer and the `proper-lockfile` `mutate()` actually gates
writes (same reasoning as calendar-store / memory-cli). Shape:

```ts
interface Checklist { slug: string; name: string; channelId?: string; items: Item[]; created: string; updated: string; }
interface Item { id: string; text: string; checked: boolean; checkedAt?: string; due?: string; remindTaskId?: string; created: string; }
```

There is **no rigid shopping/todo type** — the behaviors are opt-in: an item with `due`
gets a reminder; a checklist with `channelId` gets the Discord mirror + two-way. "Shopping"
= a checklist with neither; "todo" = one with dues and/or a channel. Slugs are
`[a-z0-9-]` (like projects), `basename`-defended, confined to the store.

## Verbs

- `checklist-cli lists` — every checklist: name, open/total counts, channel binding.
- `checklist-cli make <name> [--channel <id>]` — create (create-only; dup slug errors).
- `checklist-cli show <name>` — items, `[ ]`/`[x]`, due dates.
- `checklist-cli add <name> "<item>" [--due <ISO>]` — add an open item. Fuzzy list-name
  match; a **default list** for a bare add (configurable; falls back to the most-recently-
  used or a "general" list). A `--due` schedules a self-cancelling reminder (below).
- `checklist-cli check <name> <item…>` / `uncheck` — toggle. `<item>` is matched **fuzzily
  within the list** (so `check groceries milk` works); ambiguous → error listing candidates.
  Last-write-wins (fine at this scale).
- `checklist-cli remove <name> <item…>` — delete an item (cancels its reminder).
- `checklist-cli clear <name> [--checked]` — remove checked items (the "auto-clear when
  done"); `--checked` is the default, bare `clear` also offered for "empty the list".
- `checklist-cli rm <name>` — delete a checklist (cancels its items' reminders + channel).
- `checklist-cli find "<phrase>" [--list <name>]` — the NL resolver: ranked fuzzy search
  over **open** items across all lists (or one), returning `<score>  <list> · <item>`,
  best first. Reuses files-cli's `tokenize` + a lightweight token-overlap/substring rank
  over the short item texts. Deterministic candidates; the model decides confidence.

## The "I did X" behavior

A bare inbound message that implies completion ("finished the taxes", "got the milk",
"picked up the dry cleaning") should tick the item. Mechanism: the model runs
`checklist-cli find "<the phrase>"`, and **if a candidate is a confident, unambiguous
match, `check`s it**; does nothing if nothing scores well (never a silent check on a weak
hit). **If the phrase plausibly matches items on more than one list** (e.g. "milk" is open
on both `groceries` and `costco-run`), it **asks which list** to check it off on rather
than guessing — `find`'s output carries the list per candidate precisely so the model can
surface that choice. `find` supplies the ranked candidates (with their list); the model
supplies judgment + the disambiguating question.

## The three todo powers

### 1. Due reminders (self-cancelling)

`add … --due <ISO>` records `due` on the item. A reminder is scheduled via `schedule-cli`
so a heartbeat fire delivers it. **It fires conditionally:** the scheduled task's text is
"if `<item>` on `<list>` is still unchecked, remind about it" — when it fires, the run does
`checklist-cli show`/`find`, and only pings (email/Discord) if the item is still open, so
completing early quietly no-ops the nag. The scheduling is **agent-orchestrated** (the
skill tells the model to `schedule-cli add … --at <due>` when it adds a due'd item), which
avoids coupling `checklist-cli` to a `schedule-cli` grant it may not have on every surface;
`remindTaskId` is stored so `check`/`remove` can note the reminder is moot. (A fully
`checklist-cli`-managed reminder that auto-cancels the task is a possible v2.)

### 2. Discord channel mirror (one-way)

A checklist with `channelId` keeps a **single message** in that channel showing its open
items. On every add/check/clear of a channel-bound list, the model updates that message
(`discord-cli` edit; the message id is stored on the checklist). Post on first sync, edit
thereafter. Purely reflective — the list state in the store is the source of truth.

### 3. Complete from the channel (two-way)

Reacting on the mirror message (e.g. ✅ on the line, or a per-item message) checks the item
off. This is the one piece that touches **`discord-bot.ts`**: the existing reaction
dispatcher gains a branch — a reaction on a known checklist-mirror message maps
(reaction/line → item) to `checklist-cli check`, then re-syncs the message. Design detail
(one message with line-reactions vs one message per item) is settled in Phase 4; a
message-per-item is simplest for reaction→item mapping.

## Wiring

- `grants.ts`: `Bash(checklist-cli *)` in `CORE_TOOLS`; `checklist` in `SKILL_NAMES`.
- `Dockerfile`: PATH shim.
- `skills/checklist/SKILL.md`: verbs + the projects-vs-checklists rule + the "I did X"
  behavior + the due/channel powers. Add the reciprocal cross-reference to
  `skills/projects/SKILL.md`.
- Prompts: a short note (mail/discord) that a completion-implying message should be
  `find`-resolved and checked.

## Build phases (each its own reviewable commit(s))

1. **Core:** store (`checklist-store.ts`) + `checklist-cli` CRUD (`lists/make/show/add/
   check/uncheck/remove/clear/rm`) + `find` + tests (cross-process lock, fuzzy match, find
   ranking).
2. **Reminders:** `--due` + the self-cancelling scheduled-reminder pattern + skill guidance.
3. **Mirror (one-way):** `--channel` binding + the model-driven channel message sync +
   skill guidance.
4. **Two-way:** the `discord-bot.ts` reaction-dispatcher branch → `check` + re-sync.
5. **Wiring + NL behavior:** grants/Dockerfile/skill/projects-cross-ref/prompts + docs.

## Test plan

- `checklist-store.test.ts`: add/check/clear/remove round-trips, stable item ids,
  cross-process `mutate` lock (spawned racers, no lost add — mirrors calendar-store).
- `checklist-cli.test.ts`: fuzzy list + item match (incl. ambiguous → error), `find`
  ranking (a phrase resolves to the right open item; checked items excluded; nothing →
  empty), `clear --checked`, default-list add, the CLI round-trip via a temp STATE_DIR.
- Later phases add their own (reminder-conditional logic pure-tested; the discord reaction
  branch tested in `discord-bot.test.ts`'s dispatcher style).
- `make check` green throughout.
