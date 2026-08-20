---
name: links
description: Get a home.bax.bot link to a checklist, chat, recipe, or collection with link-cli. Use whenever you want to point the family at a specific list, chat thread, recipe, or collection by URL (in a message, email, or SMS). Verbs: one -- `link-cli <type> <name|id|slug>`; prints the URL.
allowed-tools: Bash(link-cli:*)
---

# Links with link-cli

`link-cli` resolves a checklist, chat, recipe, or collection to its `home.bax.bot` URL and prints it.
Use it whenever you want to **point someone at a specific thing by URL** — "here's the
grocery list → <link>", "the recipe is at <link>", "let's keep talking here → <chat link>".

## Commands

```
link-cli <type> <name|id|slug> [--json]
  list|lists    <name>    a checklist (fuzzy name -> slug)
  chat|chats    <id>      a home chat (wc-<n>)
  recipe|recipes <slug>   a recipe (by slug)
  collection|collections <slug-or-name> a collection (by slug or name)
```

- Prints the **bare URL** on stdout (pipe to a clipboard or paste straight into a message).
- `--json` emits `{type, url, slug|id, name|title}` instead.
- `HOME_BASE_URL` overrides the default `https://home.bax.bot` (operator-set; you don't
  control it).

## Behavior

- **Lists** take a *name* and resolve it fuzzily to the list's slug (so "grocery" finds
  "Grocery List" → `/l/grocery-list`). If the name is ambiguous across lists it errors —
  be more specific.
- **Chats** take an *id* (`wc-<n>`). It must be a real chat id.
- **Recipes** take a *slug* — the same slug `recipes-cli list` prints.
- **Collections** take a *slug* (or the collection's name — it folds to the same canonical
  slug, like recipes).

It exits nonzero if the object can't be found or the input is malformed, so you never hand
out a dead link. The URL shapes are: list `/l/<slug>`, chat `/chats/<id>`, recipe
`/r/<slug>`, collection `/c/<slug>`.

## When to use it

Reach for it any time a URL to a specific list/chat/recipe/collection would be more useful than
describing the thing in prose — sending the family a tappable link in SMS/chat/email, or
recording a pointer in memory. If the object might not exist yet, create/confirm it first.
