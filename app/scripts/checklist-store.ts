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
  due?: string; // ISO; a due'd item gets an agent-scheduled, self-cancelling reminder.
  // No stored schedule-cli task id: the reminder is agent-orchestrated and self-cancels
  // (its conditional fire finds the item gone/checked and no-ops), so the CLI never needs
  // to track or cancel it. (A CLI-managed auto-cancel is a possible v2 -> add an id then.)
  mirrorMessageId?: string; // Phase 3+: this item's own message in the mirrored Discord
  // channel (message-PER-item, so a reaction maps unambiguously to one item).
  mirrorChecked?: boolean; // the `checked` value currently rendered to that mirror message.
  // A checked item's message is struck through (not deleted); reconcile only edits when this
  // drifts from `checked` (check OR uncheck), so it doesn't re-edit every tick.
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
