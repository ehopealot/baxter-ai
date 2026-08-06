---
name: recipes
description: Capture and present recipes with recipes-cli -- a step-oriented recipe model where each step carries only the ingredients it uses and how long it takes. Use whenever a user mentions, asks about, or provides a recipe (from a link or a photo). Verbs: list/show/save/rm; save takes recipe JSON on stdin and validates it.
allowed-tools: Bash(recipes-cli:*)
---

# Recipes with recipes-cli

`recipes-cli` stores recipes in a **step-oriented** model and lets you present
them **step by step** — each step shows the ingredients *that step* uses and how
long it takes, instead of the traditional "all ingredients up front, then a wall
of prose." Reach for this whenever a user **mentions, asks about, or provides**
a recipe.

## The model

A recipe is a JSON object:

- `title` — required.
- `source` — the recipe's URL **if it came from a link**. Omit it entirely for a
  recipe read from a **photo** the user sent.
- `servings` — number of people served (integer ≥ 1).
- `timeToPrepare`, `activeTime`, `cookTime` — whole minutes.
- `ingredients` — the overall list, free-text lines like `"2 cups flour"`.
- `steps` — an ordered list; **at least one**. Each step:
  - `title` — optional label, e.g. `"Make the sauce"`.
  - `activeTime`, `cookTime` — whole minutes for *this* step.
  - `ingredients` — only the ingredients *this* step uses (may be empty, e.g. a
    "preheat the oven" step).
  - `instructions` — what to do in this step.

The whole point: **distribute each ingredient and time into the step that
actually uses it.** Don't just dump everything up front and then describe it.

## Intake

**From a link:** fetch the page (`web-cli` or WebFetch), read the recipe, and
**restructure** it into the model above — pull each ingredient down into the
step that uses it, estimate per-step active/cook time from the directions, and
set `source` to the URL.

**From a photo:** you're on a multimodal model, so read the recipe straight from
the image, restructure it the same way, and **leave `source` out**.

Then `save` it (see below). `save` validates; if it reports errors, fix them and
`save` again.

## Commands

| Command | What it does |
|---|---|
| `recipes-cli list` | Every recipe: slug, title, servings, total time, last-updated. |
| `recipes-cli show <slug>` | Print a stored recipe (readable step-by-step dump). |
| `recipes-cli show <slug> --json` | Print the raw JSON (edit it, then re-`save`). |
| `… \| recipes-cli save <slug>` | Read recipe JSON on stdin, **validate**, and create-or-replace `<slug>`. |
| `recipes-cli rm <slug>` | Delete a recipe. |

`save` **validates** the JSON. On a bad recipe it writes nothing and exits
nonzero with the specific problems on stderr — read them, fix the JSON, and
`save` again. There is no separate "validate" command; just `save`.

Pipe the JSON straight into `save` with a heredoc — don't stage a scratch file:

```
recipes-cli save weeknight-pasta <<'EOF'
{
  "title": "Weeknight Pasta",
  "source": "https://example.com/pasta",
  "servings": 4,
  "timeToPrepare": 30, "activeTime": 20, "cookTime": 10,
  "ingredients": ["1 lb pasta", "2 cups tomato sauce", "parmesan"],
  "steps": [
    { "title": "Boil the pasta", "activeTime": 2, "cookTime": 8,
      "ingredients": ["1 lb pasta"], "instructions": "Boil salted water and cook the pasta until al dente." },
    { "title": "Finish", "activeTime": 5, "cookTime": 2,
      "ingredients": ["2 cups tomato sauce", "parmesan"], "instructions": "Warm the sauce, toss the pasta in it, top with parmesan." }
  ]
}
EOF
```

Use a slug that matches the title (lowercase, hyphenated). It's slugified for
you, so `save "Weeknight Pasta"` works too.

## Presenting a recipe

When the user asks for a recipe, present it **step by step** — this is the whole
reason recipes are structured this way:

1. A short header: the title, who it serves, and the total time (and the source
   link if there is one).
2. Then, for **each step** in order: its label (if any), **the ingredients that
   step uses**, how long it'll take (active / cook), and what to do.

Don't lead with the full ingredient list and then a block of prose. Adapt the
formatting to the channel (chat, SMS, email, Discord), but always keep the
step-by-step structure where each step carries its own ingredients and timing.
`recipes-cli show <slug>` already prints in this shape — use it as the basis.

## When to use a recipe vs. just replying

Any time a recipe is in play — the user shares a link or photo of one, asks you
to save one, or asks you to pull one back up — use `recipes-cli`. For a passing
mention that isn't really about capturing or cooking a recipe, just reply.
