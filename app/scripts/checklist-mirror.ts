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

// The two REST ops the gateway supplies (real: client.rest POST/DELETE); tests inject a
// fake. No edit -- item text is immutable in v1, so an item posts once and is deleted when
// done/removed.
export interface DiscordOps {
  post(channelId: string, content: string): Promise<string>; // -> created message id
  delete(channelId: string, messageId: string): Promise<void>;
}

// The mirror message body for one item. Pure.
export function itemMessageContent(item: Item): string {
  return `- ${item.text}${item.due ? ` (due ${item.due.slice(0, 16).replace("T", " ")})` : ""}`;
}

// Pure diff for one channel-bound list: which open items need a message posted, and which
// message ids need deleting (checked items still showing + the pending-unmirror queue from
// remove/clear/rm).
export function planReconcile(list: Checklist): { toPost: Item[]; toDelete: string[] } {
  const toPost = list.items.filter((i) => !i.checked && !i.mirrorMessageId);
  const checkedShowing = list.items.filter((i) => i.checked && i.mirrorMessageId).map((i) => i.mirrorMessageId as string);
  return { toPost, toDelete: [...(list.pendingUnmirror ?? []), ...checkedShowing] };
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

// Make every channel-bound list's mirror match the store: delete stale/done messages, post
// missing ones, and record the ids -- all under the lock, re-resolving each item by id so a
// concurrent CLI mutation (add/check/remove) can't be clobbered. A message posted for an
// item that vanished before the lock is deleted as an orphan afterward.
export async function reconcile(ops: DiscordOps, path: string = CHECKLISTS_PATH): Promise<void> {
  for (const snapshot of readChecklists(path)) {
    if (!snapshot.channelId) continue;
    const channelId = snapshot.channelId;
    const plan = planReconcile(snapshot);
    if (plan.toPost.length === 0 && plan.toDelete.length === 0 && !snapshot.deleted) continue;

    for (const id of plan.toDelete) { try { await ops.delete(channelId, id); } catch { /* already gone */ } }
    const posted: { itemId: string; msgId: string }[] = [];
    for (const item of plan.toPost) posted.push({ itemId: item.id, msgId: await ops.post(channelId, itemMessageContent(item)) });

    const deletedSet = new Set(plan.toDelete);
    const orphans = await mutate(path, (lists) => {
      const l = lists.find((x) => x.slug === snapshot.slug);
      if (!l) return { lists, value: posted.map((p) => p.msgId) }; // list gone -> everything we posted is orphaned
      const orphaned: string[] = [];
      for (const { itemId, msgId } of posted) {
        const it = l.items.find((i) => i.id === itemId && !i.checked);
        if (it && !it.mirrorMessageId) it.mirrorMessageId = msgId;
        else orphaned.push(msgId); // item removed/checked between post and lock
      }
      // Drop the ids we actually deleted: from the pending queue and from any checked item.
      const remaining = (l.pendingUnmirror ?? []).filter((id) => !deletedSet.has(id));
      if (remaining.length) l.pendingUnmirror = remaining; else delete l.pendingUnmirror;
      for (const it of l.items) if (it.mirrorMessageId && deletedSet.has(it.mirrorMessageId)) delete it.mirrorMessageId;
      // A drained rm-tombstone can now be dropped.
      if (l.deleted && l.items.length === 0 && !l.pendingUnmirror) return { lists: lists.filter((x) => x.slug !== l.slug), value: orphaned };
      l.updated = new Date().toISOString();
      return { lists, value: orphaned };
    });
    for (const id of orphans) { try { await ops.delete(channelId, id); } catch { /* already gone */ } }
  }
}

// A ✅ on a mirror message: check the item off and delete its message. Returns true iff the
// message WAS a checklist mirror message (so the gateway skips the normal reaction-wake).
export async function handleReaction(messageId: string, ops: DiscordOps, path: string = CHECKLISTS_PATH): Promise<boolean> {
  if (!resolveReaction(readChecklists(path), messageId)) return false;
  // Persist the check + clear the id FIRST (so a failed delete can't leave the item open
  // with a live id that reconcile would re-post), then delete the message.
  const channelId = await mutate(path, (lists) => {
    for (const l of lists) {
      const it = l.items.find((i) => i.mirrorMessageId === messageId && !i.checked);
      if (it) {
        it.checked = true;
        it.checkedAt = new Date().toISOString();
        delete it.mirrorMessageId;
        l.updated = new Date().toISOString();
        return { lists, value: l.channelId ?? null };
      }
    }
    return { lists, value: null }; // changed concurrently -- still "handled" (it was ours)
  });
  if (channelId) { try { await ops.delete(channelId, messageId); } catch { /* already gone */ } }
  return true;
}
