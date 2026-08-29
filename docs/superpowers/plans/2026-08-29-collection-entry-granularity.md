# Collection Entry Granularity Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Ensure future Collection writes use one JSON entry per real collection item instead of putting peer items in one entry's Markdown content.

**Architecture:** This is a guidance-only change. The detailed Collections skill and each active surface prompt will state the atomic-entry rule; `content` remains Markdown for details belonging to that one entry. The existing JSON schema, CLI, renderer, and legacy-source behavior remain unchanged.

**Tech Stack:** Markdown prompt/skill documentation, TypeScript `node:test`, Node 22 with type stripping.

**Design:** `docs/superpowers/specs/2026-08-29-collection-entry-granularity-design.md`

---

### Task 1: Add the failing atomic-entry guidance regression tests

**Files:**
- Modify: `app/scripts/collections-guidance.test.ts`
- Modify: `app/scripts/mail-bot.test.ts`

**Step 1: Require the detailed skill to define the complete entry rule**

Add assertions that fail unless the Collections skill says all three:

- one entry per actual collection item;
- peer items must not be stored as a Markdown list inside one entry; and
- a Markdown list remains valid when every bullet is a detail of that one entry.

Also require a tie-breaker for less entity-shaped categories: a peer that should be shown,
referenced, or updated independently becomes a separate entry. Keep assertions semantic
enough to permit prose edits but specific enough to reject the current freeform-list-only
guidance.

**Step 2: Require every template prompt to repeat both halves of the rule**

Inside the existing seven-template loop, add the three entry-rule assertions with the
source name in the assertion message. The templates are `prompt.md` (mail's eval template),
`discord-prompt.md`, `chat-prompt.md`, `sms-prompt.md`, `heartbeat-prompt.md`,
`tui-prompt.md`, and `discord-reaction-prompt.md`.

**Step 3: Require production mail to render the rule**

In `mail-bot.test.ts`, add a focused `buildPrompt` assertion for the same atomic-entry,
peer-list prohibition, and details-list allowance. This covers production mail's inline
prompt builder; `prompt.md` alone is eval-only.

**Step 4: Run the tests to verify they fail**

Run:

```bash
cd app && node --test scripts/collections-guidance.test.ts scripts/mail-bot.test.ts
```

Expected: FAIL because PR #32's skill/templates permit freeform Markdown lists without
requiring an entry boundary, and production mail has no corresponding rendered guidance.

### Task 2: Add the atomic-entry guidance and documentation

**Files:**
- Modify: `app/skills/collections/SKILL.md`
- Modify: `app/prompt.md`
- Modify: `app/discord-prompt.md`
- Modify: `app/chat-prompt.md`
- Modify: `app/sms-prompt.md`
- Modify: `app/heartbeat-prompt.md`
- Modify: `app/tui-prompt.md`
- Modify: `app/discord-reaction-prompt.md`
- Modify: `app/scripts/mail-bot.ts`
- Modify: `app/docs/architecture/tool-clis.md`

**Step 1: Make the skill authoritative**

State that a JSON object is exactly one real collection item, with the category defining the
unit. Add explicit examples (place/person/recommendation) and a tie-breaker for
less entity-shaped categories: if a peer would be shown, referenced, or updated separately,
make it a separate entry; when unsure, prefer the finer boundary. Preserve the ability to
use Markdown lists for details of that one object, but state that a list of peer items must
become separate JSON entries.

**Step 2: Update all runtime prompt paths consistently**

Add the same concise two-part sentence to every Collections section and to production mail's
inline `buildPrompt` array. It must say that peer items belong in separate JSON objects, not
a Markdown list in one `content` field, **and** that a Markdown list remains valid when every
bullet is a detail of that one item. Retain each prompt's current surface-specific wording
and all CAS/version instructions. Keep `prompt.md` in sync as mail's eval template.

**Step 3: Update architecture documentation**

In the `collections-cli` section of `app/docs/architecture/tool-clis.md`, document the
semantic entry boundary and the permitted details-list exception. Do not describe a schema
or behavior change that does not exist.

**Step 4: Run the focused test to verify it passes**

Run:

```bash
cd app && node --test scripts/collections-guidance.test.ts scripts/mail-bot.test.ts
```

Expected: PASS with every template and production mail's rendered prompt, plus the
Collections skill, explicitly enforcing one entry per collection item while preserving
per-item detail lists.

**Step 5: Run the complete verification gate**

Run:

```bash
make check
git diff --check
git status --short
```

Expected: `make check` passes; `git diff --check` is silent; status contains only the
intentional guidance, documentation, test, and plan/spec files.

**Step 6: Commit**

```bash
git add app/scripts/collections-guidance.test.ts app/scripts/mail-bot.test.ts \
  app/skills/collections/SKILL.md app/scripts/mail-bot.ts \
  app/prompt.md app/discord-prompt.md app/chat-prompt.md app/sms-prompt.md \
  app/heartbeat-prompt.md app/tui-prompt.md app/discord-reaction-prompt.md \
  app/docs/architecture/tool-clis.md \
  docs/superpowers/specs/2026-08-29-collection-entry-granularity-design.md \
  docs/superpowers/plans/2026-08-29-collection-entry-granularity.md
git commit -m "fix(collections): require one entry per item"
```
