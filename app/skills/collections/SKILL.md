---
name: collections
description: Organize durable category-oriented data as JSON Collections with collections-cli. Each item has Markdown title/content plus Baxter-only notes; make/list/open/save/delete use a whole-file CAS version so concurrent runs cannot clobber one another.
allowed-tools: Bash(collections-cli:*)
---

# Cross-cutting JSON Collections

`collections-cli` gives you named Collections shared across every surface. A Collection's
slug is its category; its file is a JSON list of related entries. Use one when information
forms a durable, reusable category a future Baxter should deliberately open. Do not use one
for checkable work: groceries, packing, and todos belong in `checklist-cli`.

## Example structure

A Collection's whole file must be a JSON array. Every item has exactly these three string
keys:

```json
[
  {
    "title": "**Bar Iris**",
    "content": "- Polk Gulch\n- Quiet back room\n- [Menu](https://example.com/menu)",
    "notes": "Baxter-only: ask whether this is still the birthday default."
  },
  {
    "title": "Alta Plaza",
    "content": "Best on weekday mornings.",
    "notes": ""
  }
]
```

## One entry per item

Every JSON object is exactly one real item in the Collection's category: a places
Collection has one entry per place, a contacts Collection one per person, and a
recommendations Collection one per recommendation. Put peer items in separate JSON
objects, never as a Markdown list inside one entry. A Markdown list is fine when every
bullet is a detail of that one item. For less entity-shaped categories, if a peer should
be shown, referenced, or updated independently, make it a separate entry. When unsure,
prefer the finer entry boundary.

- `title` and `content` are user-facing Markdown. Content is freeform about that one
  item: paragraphs, lists, links, emphasis, inline code, and fenced code are all fine.
- `notes` is required on every item, even when empty. It is **Baxter-only internal
  context**: observations, uncertainty, follow-ups, and memory for a future Baxter.
  Never put user-provided material in `notes`.
- Home renders only `title` and `content`; `notes` is not rendered or sent to the
  family-facing Home view.
- Existing non-JSON Collections remain readable with `open`. Do not migrate them in bulk.
  When you next update one, replace its entire old body with this JSON array.

## Commands

| Command | What it does |
|---|---|
| `collections-cli list` | List Collection categories, sizes, and modification dates. |
| `collections-cli make <name>` | Create a new empty JSON Collection and print its version. |
| `collections-cli open <slug>` | Print the full JSON source and its version. |
| `… \| collections-cli save <slug> --expect <version>` | Replace the entire JSON source, only if its version is still current. |
| `collections-cli delete <slug> --expect <version>` | Irreversibly delete a whole Collection, only if its version is still current. |

## Versions prevent lost updates

Collections are shared across email, Discord, chat, SMS, and scheduled runs. Every
`open`, `make`, and successful `save` prints a short `version:` token. A save requires the
token from the version you edited:

1. `open <slug>` (or `make`) and note the `version:` token.
2. Start from the **complete** JSON array, make the change, and send the whole array to
   `save <slug> --expect <version>`.
3. If it says the Collection changed, re-open it, reapply your change to the fresh JSON,
   then save with the new token. Never retry a stale body unchanged.

The version is tool metadata, not Collection data. It is printed on stderr; if you need
only the token, use `collections-cli open <slug> 2>&1 >/dev/null`.

## Deleting a Collection

Delete a Collection only on a **clear user request**. It is irreversible: do not use it to
remove one entry or to clean up speculatively. To remove one entry, edit the complete JSON array
and `save` it instead.

1. `open <slug>` and inspect the complete source plus its `version:` token.
2. Confirm that deleting the entire category is what the user asked for, then run
   `collections-cli delete <slug> --expect <version>`.
3. If it changed, re-open it, confirm deletion still applies, and use the new version. Never
   retry a stale delete unchanged.

## How to use Collections well

- Check the Collections listed in your prompt before `make`; update an existing matching
  category instead of creating a duplicate.
- `save` replaces the entire file, not one entry. Pipe the full JSON directly into the CLI;
  do not create a scratch copy in the workspace.
- Be proactive when related user data is durable and reusable, but avoid Collections for
  one-off or speculative facts.
- After you return a list of options (for example, recommendations, search results, or
  comparisons), ask whether the user wants the results added to a new or existing Collection,
  as applicable, rather than adding the results unprompted. Do not make this offer for lists of
  steps, tasks, ingredients, or checklist items.
- Keep user facts in `title` and `content`; use `notes` only for your own internal context.
