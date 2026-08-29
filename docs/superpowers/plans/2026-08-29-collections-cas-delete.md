# Collections CAS Delete Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add a CAS-protected `collections-cli delete` command that removes an accepted Collection source and causes Home to remove its rendered projection.

**Architecture:** `delete` uses the same raw-byte version token and per-file `proper-lockfile` critical section as `save`. The shared CAS module will lock, bounded-read, compare, and unlink; the Collections wrapper supplies its existing source fence and user-facing errors. Home owns no local Collection artifact: its existing directory watcher republishes a fresh projection after the successful unlink, so coverage will prove that path rather than add a second cleanup mechanism.

**Tech Stack:** TypeScript, Node 22 `node:test`, `proper-lockfile`, filesystem watchers, Markdown documentation.

**Design:** `docs/superpowers/specs/2026-08-29-collections-cas-delete-design.md`

---

### Task 1: Write failing deletion and artifact-removal tests

**Files:**
- Modify: `app/scripts/collections-cli.test.ts`
- Modify: `app/scripts/home-bot.test.ts`
- Modify: `app/scripts/tui-core.test.ts`
- Modify: `app/scripts/collections-guidance.test.ts`

**Step 1: Specify the exported CAS delete behavior**

Import a not-yet-existing `deleteCollection` from `collections-cli.ts`. Add focused tests that:

1. make and save a JSON Collection, call `deleteCollection(root, slug, read.version)`, and assert the canonical slug and byte count, absent source, empty listing/preamble, and no `.lock`/`.tmp` artifact;
2. modify the source after reading its version, then assert a delete with the stale token rejects without leaking the current token or removing the newer body; and
3. reject missing and malformed expectations without removing the source.

Extend the existing subprocess CLI-copy test to invoke `delete kitchen-reno --expect <opened version>`, assert a zero exit and the canonical deleted-slug message, then assert the source file is absent. Also assert usage advertises `delete <slug> --expect V`.

**Step 2: Specify the Home rendered-artifact path**

Extend `home-bot.test.ts`'s existing direct-Collection-projection test. After it proves the initial source has been rendered into a pulled Home view, obtain the current version through `readCollection`, call `deleteCollection`, then invoke the already-captured Collections watcher callback. Assert a new `changed` frame occurs and the next pull has `collections: []`. This models the accepted unlink plus its existing filesystem event without relying on flaky real watcher timing.

**Step 3: Specify integration guidance**

Extend the TUI completion test so `/collections delete <prefix>` is a collection-slug completion. Extend the skill guidance test to require a `delete <slug> --expect <version>` command reference and explicit-user-request/irreversible-delete safety guidance.

**Step 4: Run the focused tests and verify red**

Run:

```bash
cd app && node --test scripts/collections-cli.test.ts scripts/home-bot.test.ts scripts/tui-core.test.ts scripts/collections-guidance.test.ts
```

Expected: FAIL because `deleteCollection` and the CLI verb do not exist, TUI does not complete it, and the Collections skill does not document it.

### Task 2: Implement the minimal locked CAS deletion

**Files:**
- Modify: `app/scripts/cas-file.ts`
- Modify: `app/scripts/collections-cli.ts`

**Step 1: Add `casDelete` to the shared CAS primitive**

Add an async helper parallel to `casSave`:

```ts
export async function casDelete(
  path: string,
  expected: string,
  staleLabel: string,
  reopenHint: string,
  options: CasSaveOptions = {},
): Promise<{ path: string; bytes: number }> {
  const release = await lockfile.lock(path, LOCK_OPTS);
  try {
    const currentBuf = (options.readCurrent ?? readCurrentOrEmpty)(path);
    if (expected !== versionToken(currentBuf)) {
      throw new Error(`${staleLabel} changed since you read it (your version ${expected} is stale) -- ${reopenHint}`);
    }
    unlinkSync(path);
    return { path, bytes: currentBuf.length };
  } finally {
    await release();
  }
}
```

Use the already-imported `unlinkSync`; preserve the same stale-token non-disclosure behavior as `casSave`.

**Step 2: Add the Collections wrapper and command parser**

Export `deleteCollection(root, name, expected)`. It should resolve with `collectionPath`, preflight a missing source to give delete-specific guidance, normalize the expectation before taking the lock, then call `casDelete` with `boundedCollectionBytes` as `readCurrent`. Use the reopen hint: re-open, confirm deletion is still wanted, then delete with the new version.

Add `delete <slug> --expect <version>` to CLI usage and dispatch. Parse its one slug and `--expect` using the same order-tolerant contract as `save`; it takes no stdin and prints `Deleted collection "<canonical-slug>".` only after `deleteCollection` resolves. Update the top-level verb comments and the now-invalid save preflight comment that says Collections has no delete verb.

**Step 3: Run focused tests and verify green**

Run the focused command from Task 1. Expected: all four suites pass, including the stale-delete and fresh-Home-projection assertions.

### Task 3: Update command guidance and architecture documentation

**Files:**
- Modify: `app/skills/collections/SKILL.md`
- Modify: `app/scripts/tui-core.ts`
- Modify: `app/scripts/tui.ts`
- Modify: `app/scripts/paths.ts`
- Modify: `app/docs/architecture/tool-clis.md`
- Modify: `app/docs/architecture/home.md`

**Step 1: Update the Collections skill**

Add `delete <slug> --expect <version>` to the command table and the version workflow. State that a deletion starts with `open`, requires the current token, is irreversible, and occurs only on a clear user request. Keep entry-level edits on the normal full-array `save` path.

**Step 2: Update TUI and source ownership**

Treat `delete` like `open`/`save` for `/collections` slug completion and update its help text. Amend `paths.ts` ownership prose to list all five Collection operations.

**Step 3: Update architecture docs**

Change the tool-CLI architecture from four to five verbs, document lock-protected compare-and-unlink behavior, and state that an accepted source deletion emits a Home directory event. Update the Home architecture to say a source deletion produces a fresh projection without the Collection; there is no local derived artifact/cache to remove.

**Step 4: Re-run focused tests**

Run the focused command from Task 1. Expected: all pass, including the guidance and TUI assertions.

### Task 4: Review and final verification

**Files:**
- Modify: `docs/superpowers/plans/2026-08-29-collections-cas-delete.md`

**Step 1: Inspect the diff**

Run:

```bash
git diff --check
git status --short
```

Ensure only the intended implementation, tests, documentation, design, and plan files changed.

**Step 2: Run full verification**

Run:

```bash
make check
```

Expected: all tests pass.

**Step 3: Request and assess a fresh-context code review**

Review the stacked diff against `fix/collection-entry-guidance`. Address every Critical or Important finding, rerun relevant tests after changes, then repeat full verification if production code changed.

**Step 4: Commit and create the stacked PR**

Commit the implementation with:

```bash
git add app/scripts/cas-file.ts app/scripts/collections-cli.ts \
  app/scripts/collections-cli.test.ts app/scripts/home-bot.test.ts \
  app/scripts/tui-core.ts app/scripts/tui-core.test.ts app/scripts/tui.ts \
  app/scripts/paths.ts app/scripts/collections-guidance.test.ts \
  app/skills/collections/SKILL.md app/docs/architecture/tool-clis.md \
  app/docs/architecture/home.md \
  docs/superpowers/plans/2026-08-29-collections-cas-delete.md
git commit -m "feat(collections): add CAS delete command"
```

Push `feat/collections-cas-delete` and create a pull request with base
`fix/collection-entry-guidance`, making it explicitly stacked on PR #33.
