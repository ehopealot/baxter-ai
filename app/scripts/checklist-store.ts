// checklist-cli's data store: checkable-item lists (groceries, packing, todos). A JSON
// array in STATE_DIR (see paths.ts CHECKLISTS_PATH) -- OUTSIDE the run's sandbox-writable
// MEMORY_DIR, so a spawned run can't corrupt it. Two writers -- checklist-cli AND the
// Discord gateway's mirror reconcile (checklist-mirror.ts) -- but BOTH go through the
// mutate() proper-lockfile below, which is cross-process, so they serialize (mirrors
// calendar-store). Functions take an explicit path so tests never touch the real workspace.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import { CHECKLISTS_PATH } from "./paths.ts";

export interface Item {
  id: string;
  text: string;
  checked: boolean;
  checkedAt?: string;
  checkedBy?: string; // display name of the family member who checked it off (home UI only; the
  // DO stamps it from the session). Absent for CLI/Discord checks. Cleared on uncheck; not
  // copied by recreate (a fresh list starts unchecked). Shown as "(@name)" on completed items.
  category?: string; // a grouping label (e.g. "Produce", "Dairy") assigned by the Sort/Group
  // operation. Absent = uncategorized. Persists across a recreate so a reset list keeps its
  // groups; the home surface renders OPEN items under category headings (completed items stay
  // flat). Written by checklist-cli `set-category` and home-sort's `sortListCommand`, both
  // through the shared capCategory (whitespace-collapsed, capped at MAX_CATEGORY -- a heading,
  // not prose).
  due?: string; // ISO; a due'd item gets an agent-scheduled, self-cancelling reminder.
  // No stored schedule-cli task id: the reminder is agent-orchestrated and self-cancels
  // (its conditional fire finds the item gone/checked and no-ops), so the CLI never needs
  // to track or cancel it. (A CLI-managed auto-cancel is a possible v2 -> add an id then.)
  mirrorMessageId?: string; // Phase 3+: this item's own message in the mirrored Discord
  // channel (message-PER-item, so a reaction maps unambiguously to one item).
  mirrorChecked?: boolean; // write-once "this message has been struck through" flag.
  // Check-off is permanent: the message is struck (not deleted) and stays struck, so this is
  // only ever set true (or cleared on a 404) -- reconcile strikes a checked item whose message
  // isn't yet struck (`checked && !mirrorChecked`) and never un-strikes; uncheck isn't mirrored.
  created: string;
}
export interface Checklist {
  id: string; // stable, assigned once at make -- reconcile matches by this, NOT slug, so a
  // recreated same-slug list can't collide with a not-yet-drained rm tombstone of the old one.
  slug: string;
  name: string;
  channelId?: string; // Discord channel this list mirrors to (opt-in; Phase 3+)
  // Message ids to DELETE from the mirror channel on the next reconcile -- populated by
  // the CLI when it drops an item (remove/clear/rm) that had a posted mirror message, so
  // the message id isn't lost with the item and the channel doesn't orphan a stale entry.
  pendingUnmirror?: string[];
  // rm tombstone: the record is kept until the gateway has cleared its channel messages
  // (drained pendingUnmirror), then dropped -- so `rm` of a mirrored list cleans up too.
  deleted?: boolean;
  // Canonical todo-list flag (2026-08-24): "household-todo" (one per tenant) or
  // "member-todo" (one per roster member, paired with memberAddress below). Minted and
  // cleared ONLY by the container-side canonical reconcile (home-mirror.ts
  // reconcileCanonicalLists, driven by every applied members snapshot); rides the published
  // view so the DO's UI can suppress the delete affordance and show an explainer. The
  // container deliberately does NOT enforce anything on delete-list -- the rule is a
  // DO-rendering concern only (operator decision 2026-08-24); a delete intent that arrives
  // is applied like any other. Removing a member clears their list's flag (the list becomes
  // an ordinary, deletable list) and nothing else. recreate-list carries both fields onto
  // the fresh copy so a reset todo list keeps its protection instead of duplicate-minting.
  special?: "household-todo" | "member-todo";
  // The member's EMAIL (login identity, trimmed lowercase) a "member-todo" list belongs
  // to -- the reconcile's idempotency key and the removal-clear match (compared
  // case-insensitively on the trimmed lowercased form, like every other address comparison
  // in this system). Deliberately NOT the phone: the roster carries one row per contact
  // method, so keying by the single email gives one todo list per PERSON (2026-08-25;
  // keying per row minted an address-labeled duplicate list for any member with both).
  memberAddress?: string;
  items: Item[];
  created: string;
  updated: string;
}

export const MAX_CHECKLISTS = 200;
export const MAX_ITEMS_PER_LIST = 1000;
// Item text length cap. Well under Discord's 2000-char message limit (the mirror posts
// "- <text> (due …)") so an over-long item can't become a message Discord rejects and
// stall the mirror; also just keeps a checklist item a checklist item.
export const MAX_ITEM_TEXT = 1000;
// A category label is a short grouping word/phrase ("Produce", "Frozen"), never prose -- capped
// well below item text so a mis-behaving sort can't bloat the store or a rendered heading.
export const MAX_CATEGORY = 64;
// The ONE category sanitizer -- both writers (checklist-cli `set-category`, home-sort's
// `sortListCommand`) go through it, so the collapse-and-cap invariant has a single definition.
export const capCategory = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, MAX_CATEGORY);

function ensureFile(p: string): void {
  mkdirSync(dirname(p), { recursive: true });
  try { writeFileSync(p, "[]", { flag: "wx" }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
}

export function readChecklists(p: string = CHECKLISTS_PATH): Checklist[] {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Checklist[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

// Read -> transform -> atomically write, under a proper-lockfile lock, so concurrent
// mutations across surfaces serialize instead of clobbering (mirrors calendar-store).
export async function mutate<V>(p: string, fn: (lists: Checklist[]) => { lists: Checklist[]; value: V }): Promise<V> {
  ensureFile(p);
  const release = await lockfile.lock(p, { realpath: false, stale: 10000, retries: { retries: 30, minTimeout: 30, maxTimeout: 300 } });
  try {
    const lists = readChecklists(p);
    // Backfill ids on any record written before `id` existed (earlier commits on this
    // branch). Without it, id-based matching in reconcile misbehaves on id-less records:
    // find(x => x.id === undefined) matches the FIRST such list, and the tombstone-drop
    // filter(x => x.id !== undefined) would drop them ALL (silent data loss). reconcile
    // runs a no-op mutate up front to persist this before it snapshots, so its id matches
    // never see an undefined id.
    for (const l of lists) if (!l.id) l.id = newItemId();
    const { lists: next, value } = fn(lists);
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, p);
    return value;
  } finally {
    await release();
  }
}

export function newItemId(): string {
  return randomBytes(8).toString("hex");
}

// Retire a list, mirror-safe -- the ONE tombstone-or-drop rule shared by checklist-cli's `rm`/
// `recreate` and home-mirror's delete-list/recreate-list applyIntent (lives here, in the store
// module both import, so there is a single copy to change). Queue the list's posted mirror-message
// ids for the gateway, then TOMBSTONE it in place if any need draining (deleted + emptied, kept in
// `lists` so the gateway can clear the channel) or DROP it OUTRIGHT by stable id otherwise (a
// same-slug tombstone draining alongside a recreation isn't stranded). Returns the resulting lists
// array; a caller that replaces the list (recreate) appends its fresh copy after it. `now` is the
// tombstone's `updated` stamp -- passed in so each caller uses its own clock (intent.at vs now).
export function retireList(lists: Checklist[], list: Checklist, now: string): Checklist[] {
  const ids = list.items.map((i) => i.mirrorMessageId).filter((x): x is string => !!x);
  if (ids.length) list.pendingUnmirror = [...(list.pendingUnmirror ?? []), ...ids];
  if ((list.pendingUnmirror?.length ?? 0) > 0) {
    list.deleted = true;
    list.items = [];
    list.updated = now;
    return lists; // tombstoned in place -> stays in the array, draining
  }
  return lists.filter((l) => l.id !== list.id); // dropped outright
}
