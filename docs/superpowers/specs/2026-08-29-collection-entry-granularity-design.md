# Collection Entry Granularity

**Date:** 2026-08-29

**Status:** Approved — guidance-only correction

## Problem

PR #32 made a Collection a JSON array of `{title, content, notes}` entries, but its
Collections skill also described `content` as freeform Markdown including lists. That
leaves the model free to put several peer items into one entry's Markdown list. Home
then presents one entry instead of one independently addressable item per collection
unit.

## Decision

A JSON entry represents exactly one real item in its Collection. The category determines
what an item is: a places collection has one entry per place, a contacts collection has
one entry per person, and a recommendations collection has one entry per recommendation.
For less entity-shaped categories, choose the repeated unit before writing: if a bullet
is a peer that should be shown, referenced, or updated independently, make it a separate
entry; when unsure, prefer the finer-grained entry boundary.

`content` remains Markdown for supporting details of that entry. A Markdown list is
therefore still valid when every bullet describes the same item, but it must never be
used to serialize several peer collection items inside one entry. When a run creates or
substantively updates a Collection, it writes peer items as separate objects in the full
JSON array.

The detailed `collections` skill is the primary instruction. Every runtime prompt path,
including production mail's inline prompt builder, repeats both the atomic-entry rule and
the details-list exception. `prompt.md` mirrors the rule in mail's eval template. The
tool-CLI architecture document will describe the same distinction.

## Compatibility and non-goals

There is no schema, CLI, renderer, or migration change. Existing one-entry Markdown
lists stay readable and are not batch-rewritten. This only guides future creation and
edits; a later intentional edit may split peer items while preserving their user-visible
content and Baxter-only notes.

Semantic validation is intentionally out of scope: code cannot reliably distinguish a
list of peer items from legitimate details about one item. Automatic migration would
require the same unreliable inference and risks data loss or incorrect splitting.

## Verification

Extend the Collections guidance tests first so they require the atomic-entry rule, the
prohibition on storing peer items as a Markdown list inside one entry, and the permission
to use lists for details of that one entry. Cover the skill, the seven template prompts,
and production mail's rendered prompt. Run those focused tests red, update the guidance
and architecture documentation, then run the focused tests and `make check`.
