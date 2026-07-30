// checklist-cli's data store: checkable-item lists (groceries, packing, todos). A JSON
// array in STATE_DIR (see paths.ts CHECKLISTS_PATH) -- OUTSIDE the run's sandbox-writable
// MEMORY_DIR, so checklist-cli is the only writer and the proper-lockfile mutate() gates
// every write (mirrors calendar-store). Functions take an explicit path so tests never
// touch the real workspace.
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
  created: string;
}
export interface Checklist {
  slug: string;
  name: string;
  channelId?: string; // Discord channel this list mirrors to (opt-in; Phase 3+)
  items: Item[];
  created: string;
  updated: string;
}

export const MAX_CHECKLISTS = 200;
export const MAX_ITEMS_PER_LIST = 1000;

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
