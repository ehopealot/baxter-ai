// Discord "todo channel" mirror for channel-bound checklists (checklist-cli --channel).
// A channel-bound list shows ONE message per open item; reacting ✅ on an item's message
// checks it off. The Discord gateway (discord-bot.ts) drives this via two thin hooks -- a
// periodic reconcile() and a reaction branch calling handleReaction() -- but all the
// logic lives here, behind an injectable DiscordOps seam so the diff + resolution are
// unit-testable with a fake channel and a temp store (no live client).
//
// The store (checklist-store) is the source of truth; the channel is reflective. Writes go
// through the SAME proper-lockfile mutate() the CLI uses, so gateway + CLI serialize.
import { readChecklists, mutate } from "./checklist-store.ts";
import type { Checklist, Item } from "./checklist-store.ts";
import { CHECKLISTS_PATH } from "./paths.ts";

// The REST ops the gateway supplies (real: client.rest POST/PATCH/DELETE); tests inject a
// fake. `edit` is how a checked item's message is struck through (not deleted); `delete` is
// now only for removals (remove/clear/rm) and orphan cleanup. Item text is immutable in v1,
// so `edit` only ever swaps between the open and struck-through renderings of one item.
export interface DiscordOps {
  post(channelId: string, content: string): Promise<string>; // -> created message id
  edit(channelId: string, messageId: string, content: string): Promise<void>;
  delete(channelId: string, messageId: string): Promise<void>;
}

// The mirror message body for one item. Pure. A checked item is struck through with a ✅
// appended (the whole body, due included, goes inside the strikethrough) rather than removed
// from the channel, so a completed list still reads as a list.
export function itemMessageContent(item: Item): string {
  const body = `${item.text}${item.due ? ` (due ${item.due.slice(0, 16).replace("T", " ")})` : ""}`;
  return item.checked ? `- ~~${body}~~ ✅` : `- ${body}`;
}

// Pure diff for one channel-bound list: which open items need a message posted, which
// existing messages need their content re-rendered (a checked/unchecked item whose message
// still shows the other form -- detected by mirrorChecked drifting from checked), and which
// message ids need deleting (ONLY the pending-unmirror queue from remove/clear/rm -- a
// checked item is struck through in place, never deleted). Each toEdit entry carries the
// `checked` value it renders, so reconcile can record it as the message's new mirrorChecked.
export function planReconcile(list: Checklist): { toPost: Item[]; toEdit: { id: string; content: string; checked: boolean }[]; toDelete: string[] } {
  const toPost = list.items.filter((i) => !i.checked && !i.mirrorMessageId);
  const toEdit = list.items
    .filter((i) => i.mirrorMessageId && Boolean(i.mirrorChecked) !== i.checked)
    .map((i) => ({ id: i.mirrorMessageId as string, content: itemMessageContent(i), checked: i.checked }));
  return { toPost, toEdit, toDelete: [...(list.pendingUnmirror ?? [])] };
}

// The set of all live mirror message ids. The gateway caches this after each reconcile so
// it can O(1)-recognize a reaction ON a mirror message (any emoji) without a disk read per
// reaction -- and consume ALL such reactions, so a mirror message never wakes an LLM run.
export function mirrorMessageIdSet(path: string = CHECKLISTS_PATH): Set<string> {
  const ids = new Set<string>();
  for (const l of readChecklists(path)) {
    for (const i of l.items) if (i.mirrorMessageId) ids.add(i.mirrorMessageId); // open OR checked (struck, still in channel)
    for (const id of l.pendingUnmirror ?? []) ids.add(id); // queued-for-delete but still in the channel
  }
  return ids;
}

// Pure: the open item a reaction on `messageId` targets, or null (not a mirror message).
export function resolveReaction(lists: Checklist[], messageId: string): { slug: string; item: Item } | null {
  for (const l of lists) {
    if (l.deleted) continue;
    const item = l.items.find((i) => i.mirrorMessageId === messageId && !i.checked);
    if (item) return { slug: l.slug, item };
  }
  return null;
}

// A delete that means "the message is genuinely gone" (so we can stop tracking it): HTTP
// 404 or Discord's "Unknown Message" (10008). A transient failure (429/5xx/network) is NOT
// this -- we keep the id queued and retry next tick rather than orphaning the message.
function isGone(err: unknown): boolean {
  const e = err as { status?: number; code?: number } | null;
  return e?.status === 404 || e?.code === 10008;
}

// Make every channel-bound list's mirror match the store: delete stale/done messages, post
// missing ones, and record the ids -- all under the lock, re-resolving each item by id so a
// concurrent CLI mutation (add/check/remove) can't be clobbered. A message posted for an
// item that vanished before the lock is deleted as an orphan afterward.
export async function reconcile(ops: DiscordOps, path: string = CHECKLISTS_PATH): Promise<void> {
  // Persist any id backfill FIRST (a no-op mutate) so `snapshot.id` below is never undefined
  // for a legacy pre-id record -- otherwise the snapshot (a plain read) carries undefined ids
  // while the in-lock lists have fresh ones, so every id match misses and a legacy channel-
  // bound list's messages orphan + re-post for a sweep. Doing it here makes the migration
  // seamless. Read once; only re-read after a backfill actually ran (fires at most once per store).
  let all = readChecklists(path);
  if (all.some((l) => !l.id)) { await mutate(path, (lists) => ({ lists, value: null })); all = readChecklists(path); }
  for (const snapshot of all) {
    if (!snapshot.channelId) continue;
    const channelId = snapshot.channelId;
    const plan = planReconcile(snapshot);
    if (plan.toPost.length === 0 && plan.toEdit.length === 0 && plan.toDelete.length === 0 && !snapshot.deleted) continue;

    // Only ids that actually went away (deleted OR 404) get cleared below; a transient
    // failure stays queued for a retry instead of orphaning the channel message.
    const deletedOk = new Set<string>();
    for (const id of plan.toDelete) {
      try { await ops.delete(channelId, id); deletedOk.add(id); }
      catch (err) { if (isGone(err)) deletedOk.add(id); }
    }
    // Re-render drifted messages (checked -> struck, unchecked -> plain). On success record
    // the checked value we rendered (so the message isn't re-edited next tick); if the
    // message is gone (404), clear its id (an OPEN item re-posts next tick; a checked item
    // just stops being mirrored -- we don't re-post a struck record over a manual delete); a
    // transient failure is left to retry.
    const editedOk = new Map<string, boolean>(); // messageId -> the checked value now shown
    const editedGone = new Set<string>();
    for (const e of plan.toEdit) {
      try { await ops.edit(channelId, e.id, e.content); editedOk.set(e.id, e.checked); }
      catch (err) { if (isGone(err)) editedGone.add(e.id); }
    }
    // One item Discord rejects (e.g. an over-long body) must NOT abort the whole sweep --
    // it just doesn't get an id this tick and is retried; other items/lists still reconcile.
    const posted: { itemId: string; msgId: string }[] = [];
    for (const item of plan.toPost) {
      try { posted.push({ itemId: item.id, msgId: await ops.post(channelId, itemMessageContent(item)) }); }
      catch { /* skip this item this tick */ }
    }

    const orphans = await mutate(path, (lists) => {
      const l = lists.find((x) => x.id === snapshot.id); // by STABLE id, never slug (a tombstone can share a recreated list's slug)
      if (!l) return { lists, value: posted.map((p) => p.msgId) }; // list gone -> everything we posted is orphaned
      const orphaned: string[] = [];
      for (const { itemId, msgId } of posted) {
        const it = l.items.find((i) => i.id === itemId && !i.checked);
        if (it && !it.mirrorMessageId) it.mirrorMessageId = msgId;
        else orphaned.push(msgId); // item removed/checked between post and lock
      }
      // Drop only the ids we actually deleted: from the pending queue and from any item.
      const remaining = (l.pendingUnmirror ?? []).filter((id) => !deletedOk.has(id));
      if (remaining.length) l.pendingUnmirror = remaining; else delete l.pendingUnmirror;
      for (const it of l.items) if (it.mirrorMessageId && deletedOk.has(it.mirrorMessageId)) { delete it.mirrorMessageId; delete it.mirrorChecked; }
      // Record re-renders: a struck/plain message now matches its item (by the value we
      // rendered, not the current one -- a concurrent re-check leaves the drift for next tick);
      // a message that 404'd loses its id (an open item re-posts next tick; a checked item just
      // stops being mirrored, so we don't fight a manual delete of the struck record).
      for (const it of l.items) {
        if (!it.mirrorMessageId) continue;
        if (editedOk.has(it.mirrorMessageId)) it.mirrorChecked = editedOk.get(it.mirrorMessageId);
        else if (editedGone.has(it.mirrorMessageId)) { delete it.mirrorMessageId; delete it.mirrorChecked; }
      }
      // A drained rm-tombstone can now be dropped -- by identity, so a same-slug recreated list survives.
      if (l.deleted && l.items.length === 0 && !l.pendingUnmirror) return { lists: lists.filter((x) => x.id !== l.id), value: orphaned };
      l.updated = new Date().toISOString();
      return { lists, value: orphaned };
    });
    const failedOrphans: string[] = [];
    for (const id of orphans) { try { await ops.delete(channelId, id); } catch (err) { if (!isGone(err)) failedOrphans.push(id); } }
    if (failedOrphans.length) {
      await mutate(path, (lists) => {
        const l = lists.find((x) => x.id === snapshot.id); // still live (orphans only come from posts, which tombstones don't do)
        if (l) l.pendingUnmirror = [...(l.pendingUnmirror ?? []), ...failedOrphans];
        return { lists, value: null };
      });
    }
  }
}

// A ✅ on a mirror message: check the item off and strike its message through (keep it in the
// channel). Returns true iff the message WAS a checklist mirror message (so the gateway skips
// the normal reaction-wake). The mirrorMessageId is always kept -- the message stays, it's just
// re-rendered struck. The eager edit gives instant feedback; if it fails, mirrorChecked stays
// unset so reconcile's drift check re-edits it (idempotent, retryable).
export async function handleReaction(messageId: string, ops: DiscordOps, path: string = CHECKLISTS_PATH): Promise<boolean> {
  if (!resolveReaction(readChecklists(path), messageId)) return false;
  // Render the struck content INSIDE the lock, where the item is now checked, so the eager
  // edit below shows exactly the checked form.
  const done = await mutate(path, (lists) => {
    for (const l of lists) {
      const it = l.items.find((i) => i.mirrorMessageId === messageId && !i.checked);
      if (it) {
        it.checked = true;
        it.checkedAt = new Date().toISOString();
        l.updated = new Date().toISOString();
        return { lists, value: l.channelId ? { channelId: l.channelId, content: itemMessageContent(it) } : null };
      }
    }
    return { lists, value: null }; // changed concurrently -- still "handled" (it was ours)
  });
  if (done) {
    try {
      await ops.edit(done.channelId, messageId, done.content);
      // Record that the message now shows the STRUCK form -- keyed to the message, not the
      // item's current `checked`. If a concurrent uncheck flipped the item between the edit and
      // here, mirrorChecked=true still correctly describes what's on screen, so reconcile's
      // drift check (true !== checked:false) re-renders it back to plain rather than being fooled
      // into thinking a struck message already matches an open item.
      await mutate(path, (lists) => {
        for (const l of lists) {
          const it = l.items.find((i) => i.mirrorMessageId === messageId);
          if (it) { it.mirrorChecked = true; break; }
        }
        return { lists, value: null };
      });
    } catch { /* leave mirrorChecked unset -- reconcile re-edits */ }
  }
  return true;
}
