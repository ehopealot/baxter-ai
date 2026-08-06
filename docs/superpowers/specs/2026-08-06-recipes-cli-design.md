# Recipes — recipes-cli + recipes skill

**Date:** 2026-08-06
**Status:** Approved (design); pending implementation plan

## Goal

Give Baxter a new content type, **recipes**, so that whenever a user mentions,
asks about, or provides a recipe, Baxter captures it in a structured,
step-oriented model and presents it **step by step** — each step carrying only
the ingredients it uses and how long it takes — rather than the traditional
"all ingredients up front, then a wall of prose."

Delivered as a small `recipes-cli` (storage + format validation) plus an
LLM-friendly `recipes` skill (intake + presentation). Text-based only; a
family-facing home web page is a deliberate later follow-up, out of scope here.

## Background

Baxter's content types follow one shape (see
`app/docs/architecture/tool-clis.md`): a CLI + a store + a `SKILL.md`, wired as
a shared-core tool so every surface (email, Discord, heartbeat, SMS, chat) gets
it. `checklist-cli`/`calendar-cli` are the closest analogs — a JSON store in
`STATE_DIR` (outside the run's sandbox-writable `MEMORY_DIR`, so only the CLI
can mutate it), guarded by a `proper-lockfile` `mutate()`.

Recipes differ from checklists/projects in that a recipe is a **structured
document** with a fixed schema, so the CLI's job is storage **plus format
validation**, and the skill owns the reorganization + presentation behavior.

## Design

### 1. Data model (`scripts/recipes-store.ts`)

Times are **whole minutes** (non-negative integers). Baxter authors every field;
the CLI validates **shape only** — required fields present, correct types, within
caps — and does **not** cross-check that recipe-level aggregates match the steps
(recipe-level and per-step times/ingredients may legitimately differ, e.g. steps
overlap, or the overall list is worded differently than the per-step lines).

```ts
export interface Step {
  title?: string;         // optional label, e.g. "Make the sauce"
  activeTime: number;     // minutes, integer >= 0
  cookTime: number;       // minutes, integer >= 0
  ingredients: string[];  // ingredients THIS step uses; may be empty (e.g. "preheat oven")
  instructions: string;   // the step's directions; non-empty after trim
}

export interface Recipe {
  title: string;          // required, non-empty after trim; slug derived from it
  source?: string;        // http(s) URL when sourced from a link; ABSENT when from a photo
  servings: number;       // "number served", integer >= 1
  timeToPrepare: number;  // total, minutes, integer >= 0
  activeTime: number;     // minutes, integer >= 0
  cookTime: number;       // minutes, integer >= 0
  ingredients: string[];  // overall list, free-text lines ("2 cups flour"); >= 1 entry
  steps: Step[];          // >= 1 step
}
```

**Ingredients are free-text strings**, not `{qty, unit, item}` — fits loose
validation and LLM authoring, and avoids unit-math. `slug` is not stored in the
body; it is derived from `title` and is the filename (§2).

### 2. Storage (`scripts/recipes-store.ts`)

- **One JSON file per recipe** at `STATE_DIR/recipes/<slug>.json` (`RECIPES_DIR`,
  added to `paths.ts`). In `STATE_DIR`, **not** `MEMORY_DIR`, so the run cannot
  bypass validation with a native `Write` — recipes are mutable only through the
  validating CLI. (Same posture as checklist/calendar stores.)
- **Slug** derives from `title`: lowercased, non-`[a-z0-9]` runs collapsed to
  `-`, trimmed of leading/trailing `-`, length-capped (≤ 64). Empty result is a
  validation error. `basename`-defended and resolved under `RECIPES_DIR`, so a
  crafted title can never escape the directory (same guard as `projects-cli`).
- **Writes are atomic** (temp sibling + `rename`) under a `proper-lockfile` lock,
  via a `mutate()`-style helper mirroring `checklist-store`/`calendar-store`, so
  concurrent CLI invocations across surfaces serialize. **No CAS `--expect`
  version token** — the CLI is the sole writer, whole-recipe `save` is
  create-or-replace, and concurrent edits of the *same* recipe are rare;
  last-write-wins under the lock is sufficient (accepted, documented residual).
- **Caps** (reject over-cap input, exit nonzero): `MAX_RECIPES` (e.g. 500),
  `MAX_STEPS_PER_RECIPE` (e.g. 100), `MAX_INGREDIENTS` per list (e.g. 200),
  `MAX_TITLE_LEN` (e.g. 200), `MAX_INGREDIENT_LEN` (e.g. 300),
  `MAX_INSTRUCTIONS_LEN` (e.g. 4000), `MAX_STEP_TITLE_LEN` (e.g. 200),
  `MAX_SOURCE_LEN` (e.g. 2000). Times capped at a sane ceiling (e.g. ≤ 100000
  min) so a garbage number can't be stored.

### 3. Validation rules

A single exported `validateRecipe(input: unknown): { recipe: Recipe } | { errors: string[] }`
(pure, unit-tested) used by both `save` and `validate`. Rules:

- `title`: string, non-empty after trim, ≤ `MAX_TITLE_LEN`, slugifiable to a
  non-empty slug.
- `source`: optional; if present, a string that parses as an `http:`/`https:`
  URL (reject other schemes), ≤ `MAX_SOURCE_LEN`.
- `servings`: integer ≥ 1.
- `timeToPrepare`, `activeTime`, `cookTime`: integers ≥ 0, ≤ time ceiling.
- `ingredients`: array of ≥ 1 non-empty strings, each ≤ `MAX_INGREDIENT_LEN`,
  count ≤ `MAX_INGREDIENTS`.
- `steps`: array of ≥ 1, count ≤ `MAX_STEPS_PER_RECIPE`; each step:
  - `title`: optional string ≤ `MAX_STEP_TITLE_LEN`.
  - `activeTime`, `cookTime`: integers ≥ 0, ≤ time ceiling.
  - `ingredients`: array of strings (**may be empty**), each non-empty and
    ≤ `MAX_INGREDIENT_LEN`, count ≤ `MAX_INGREDIENTS`.
  - `instructions`: string, non-empty after trim, ≤ `MAX_INSTRUCTIONS_LEN`.
- Unknown top-level or per-step keys are ignored (not an error) — forgiving of
  extra fields, strict on the ones that matter.
- Errors accumulate into a list (report all problems at once, not just the
  first) so Baxter can fix everything in one retry.

### 4. CLI verbs (`scripts/recipes-cli.ts`)

| Command | Behavior |
|---|---|
| `recipes-cli list` | Every recipe: slug, title, servings, total time, last-updated. |
| `recipes-cli show <slug> [--json]` | Print the full stored recipe. Default: a readable structured dump; `--json` emits the raw JSON (so Baxter can re-`save` an edit). Unknown slug → nonzero. |
| `… \| recipes-cli save <slug>` | Read recipe JSON on stdin, `validateRecipe`, then create-or-replace `<slug>.json` atomically. Slug from the arg (its slugified form); on success print the slug. Validation failure → nonzero with all errors on stderr, no write. |
| `… \| recipes-cli validate` | Read recipe JSON on stdin, `validateRecipe`, print `ok` or the error list. **No write.** Invalid → nonzero. The "check the format" verb, also usable before `save`. |
| `recipes-cli rm <slug>` | Delete `<slug>.json`. Unknown slug → nonzero. |

**Exit codes:** the CLI exits **nonzero on any validation failure or misuse**
(missing/extra args, unknown verb, unknown slug, malformed stdin JSON), with the
specific reason on stderr — per the run_cli invariant that CLIs signal misuse by
exit status, not just text. Success exits 0.

Note: `save <slug>` slugifies the arg the same way the store does; the `title`
inside the JSON is the display name. If the arg-slug and the title-slug differ,
the arg-slug wins as the filename (Baxter is told to pass a slug matching the
title, but the arg is authoritative so an explicit rename/overwrite is possible).

### 5. Skill (`skills/recipes/SKILL.md`) — owns intake + presentation

The CLI stores and validates; the skill teaches the behavior the user cares
about. Written LLM-friendly (like the other skills), covering:

- **What a recipe is** and the model (the fields above), with the core idea:
  **distribute each ingredient and time to the step that actually uses it** —
  don't dump everything up front.
- **Intake:**
  - From a **link**: fetch the page (`web-cli` / `WebFetch`), extract the
    recipe, restructure into the per-step model, set `source` to the URL.
  - From a **photo**: read the image (Baxter is on a multimodal model),
    restructure into the model, leave `source` absent.
  - Validate with `recipes-cli validate` (or just `save`, which validates), fix
    any reported errors, then `save`.
- **Presentation** (the whole point): render **step by step** — a short header
  (title, servings, total time; source link if present), then per step: its
  title (if any), the ingredients *that step* uses, how long it will take
  (active / cook), and the directions. Explicitly **not** the traditional
  all-ingredients-up-front-then-prose layout. Adapt formatting to the channel
  (chat/SMS/email/Discord) but keep the step-by-step structure.
- **When to use:** any time a user mentions, asks about, or provides a recipe.
- **Command reference** for `list`/`show`/`save`/`validate`/`rm`, with a
  stdin-heredoc `save` example (like the `projects` skill).

### 6. Wiring

- `scripts/paths.ts`: add `RECIPES_DIR` (`STATE_DIR/recipes`).
- `scripts/grants.ts`: add `Bash(recipes-cli *)` to `CORE_TOOLS`; add `recipes`
  to `SKILL_NAMES`. Both flow to every surface automatically (`recipes` lands in
  each surface's `SKILL_SRCS` → `BAKED_SKILL_NAMES`); no per-surface exclusion.
- **PATH shim + run_cli entry**: register `recipes-cli` exactly as
  `checklist-cli` is (Dockerfile shim on PATH; the run_cli/shim mapping to
  `scripts/recipes-cli.ts`). Follow the existing checklist wiring verbatim.
- `app/docs/architecture/tool-clis.md`: add a `recipes-cli` paragraph and its
  name to the file's header list.

## Routing / data flow summary

```
user mentions/provides a recipe (link or photo, any surface)
  -> recipes skill: extract + restructure into the per-step model
  -> recipes-cli validate  (fix errors)  ->  recipes-cli save <slug>
  -> STATE_DIR/recipes/<slug>.json  (validated, atomic, locked)

user asks for a recipe
  -> recipes-cli list / show <slug>
  -> skill renders step-by-step for the channel
```

## Testing

- `scripts/recipes-store.test.ts`: `validateRecipe` matrix (each rule: valid,
  missing, wrong type, empty, over-cap, bad source scheme, empty-slug title,
  step with empty ingredients OK, error-accumulation returns all problems);
  slug derivation + traversal-escape defense; `save`/`read`/`list`/`rm`
  round-trip; atomic write + lock serialization; caps enforced.
- `scripts/recipes-cli.test.ts`: each verb; `save`/`validate` read stdin;
  `validate` writes nothing; unknown verb / missing args / unknown slug /
  malformed JSON / validation failure all **exit nonzero** with a message;
  success exits 0; `show --json` round-trips into `save`.

## Global constraints

- Text-based only; no home web page in this project (later follow-up).
- CLI is the **sole writer**; recipes live in `STATE_DIR`, never `MEMORY_DIR`,
  so validation can't be bypassed by a native `Write`.
- Slugs are `[a-z0-9-]`, length-capped, `basename`-defended, resolved under
  `RECIPES_DIR` — no directory escape.
- CLI **exits nonzero on any misuse or validation failure** (run_cli invariant).
- `source` is optional and, when present, must be an `http(s)` URL; a photo
  recipe has no `source`.
- Validation is **shape-only** — no cross-checking of recipe-level aggregates
  against per-step data.
- New skill `recipes` flows to all surfaces via `SKILL_NAMES`; new tool grant
  `Bash(recipes-cli *)` via `CORE_TOOLS`.
