# Collections CAS Delete Design

## Goal

Add a destructive `collections-cli delete <slug> --expect <version>` command that removes
exactly one Collection only when the caller proves it is deleting the version it inspected.

## Scope

Collections remain one JSON source file per category. `delete` resolves the supplied name through
the existing slug/path confinement, requires the same 8-hex raw-byte version token emitted by
`open`, `make`, and `save`, and removes the source only after a locked re-read confirms that token.
There is no unconditional form, alias, undo store, bulk deletion, or migration of legacy files.

The command removes a source file, not a Collection entry inside its JSON array. Removing an entry
continues to be an `open` → edit complete JSON array → `save` operation.

## CAS and errors

A new shared `casDelete` helper will reuse `cas-file.ts`'s lock settings. It locks the target,
rereads the current bytes inside that lock through Collections' bounded descriptor fence, compares
the supplied token, and calls `unlinkSync` only on a match. This serializes a delete with a
cooperating `save` and prevents a stale delete from removing a newer save.

A missing or malformed `--expect`, a missing Collection, an oversized/symlinked/unreadable source,
or a stale token fails without unlinking. As with `casSave`, a stale error may echo the caller's
stale token but must never disclose the current token. The CLI reports the canonical deleted slug
on stdout and emits no replacement version because the object no longer exists.

## Rendered artifacts

Collections have no local derived HTML or cache to unlink. Home renders a fresh projection from
`COLLECTIONS_DIR`; its directory watcher runs the ordinary view-digest path for every event,
including an accepted unlink. That path causes the Durable Object to pull a fresh view without the
Collection, replacing the remote rendered artifact. The change adds regression coverage of this
source-delete → watcher callback → changed notice → fresh empty projection flow rather than adding
a second, racy cleanup channel.

## User guidance and integration

The Collections skill will document `delete` alongside `save`, including the required
`open`-then-delete version flow and the requirement for an explicit user request before irreversible
delete. CLI usage, tool-CLI architecture, path ownership, Home publication documentation, and TUI
collection-slug completion will reflect the fifth verb.

## Verification

Focused tests will cover successful deletion, stale and invalid deletion preserving the source,
CLI parsing/output, lock cleanup, TUI completion, and removal from the next Home view. The complete
`make check` suite remains the final verification gate.
