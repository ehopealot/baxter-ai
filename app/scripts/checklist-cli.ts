#!/usr/bin/env node
// checklist-cli: checkable-item lists (groceries, packing, todos) -- items get checked
// off, then cleared. DISTINCT from projects-cli: a checklist is things you COMPLETE; a
// project is aggregating notes that never get "done" (rule of thumb: can each entry be
// checked off? -> checklist). Self-contained STATE_DIR store (checklist-store.ts). Pure
// matching helpers are exported for tests; the CLI dispatch at the bottom is guarded so
// importing this file doesn't run it.
import { pathToFileURL } from "node:url";
import { CHECKLISTS_PATH } from "./paths.ts";
import { readChecklists, mutate, newItemId, retireList, capCategory, MAX_CHECKLISTS, MAX_ITEMS_PER_LIST, MAX_ITEM_TEXT } from "./checklist-store.ts";
import type { Checklist, Item } from "./checklist-store.ts";
import { slugify } from "./projects-cli.ts";
import { tokenize } from "./files-cli.ts";
import { parseFlags } from "./cli-flags.ts";

// --- fuzzy matching (exported for tests) ---

// A 0..1 relevance of `query` to `text`, over the shared tokenizer (light singular
// stemming, so "milk"/"milks" and "taxes"/"tax" align). Fraction of query tokens present,
// plus a boost when one tokenized phrase contains the other.
export function matchScore(query: string, text: string): number {
  const q = tokenize(query);
  const t = tokenize(text);
  if (q.length === 0 || t.length === 0) return 0;
  const set = new Set(t);
  let overlap = 0;
  for (const term of q) if (set.has(term)) overlap++;
  const tokenScore = overlap / q.length;
  const nq = q.join(" ");
  const nt = t.join(" ");
  const boost = nt.includes(nq) || nq.includes(nt) ? 0.3 : 0;
  return Math.min(1, tokenScore + boost);
}

export interface FoundItem { listSlug: string; listName: string; item: Item; score: number; }

// Ranked items matching `phrase`, across all lists or one. By default only OPEN items are
// returned (checked items are "done" -- the common "I did X" reverse-lookup doesn't want
// to wade through old work). Pass includeChecked=true when the caller DOESN'T know whether
// the item is open or already done ("which list was X on, again?"): checked hits come back
// alongside open ones, ranked by the same score. Best first; floor 0.34 (at least one
// shared query token, or a containment boost).
export function findOpen(lists: Checklist[], phrase: string, listSlug?: string, includeChecked = false): FoundItem[] {
  const out: FoundItem[] = [];
  for (const l of lists) {
    if (l.deleted) continue; // rm tombstone awaiting gateway cleanup -- invisible to users
    if (listSlug && l.slug !== listSlug) continue;
    for (const item of l.items) {
      if (!includeChecked && item.checked) continue;
      const score = matchScore(phrase, item.text);
      if (score >= 0.34) out.push({ listSlug: l.slug, listName: l.name, item, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// Resolve a list by slug/name, then fuzzily. Throws (listing available lists) if nothing
// confidently matches.
export function resolveList(lists: Checklist[], name: string): Checklist {
  const active = lists.filter((l) => !l.deleted); // a tombstoned (rm'd) list can't be resolved
  const wanted = slugify(name);
  const exact = active.find((l) => l.slug === wanted || l.name.toLowerCase() === String(name).toLowerCase());
  if (exact) return exact;
  const ranked = active.map((l) => ({ l, s: matchScore(name, l.name) })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s);
  if (ranked.length === 1 || (ranked.length > 1 && ranked[0].s > ranked[1].s)) return ranked[0].l;
  const names = active.map((l) => l.slug).join(", ") || "(none yet -- `make` one first)";
  throw new Error(`no list matching "${name}". Lists: ${names}`);
}

// Resolve an item within a list by fuzzy text, from a candidate pool: `open` (to check),
// `checked` (to uncheck), or `any` (to remove). Throws on no match, or on an ambiguous tie
// (so the caller/model disambiguates rather than acting on the wrong thing).
export function resolveItem(list: Checklist, phrase: string, pool: "open" | "checked" | "any" = "open"): Item {
  const eligible = list.items.filter((i) => pool === "any" || i.checked === (pool === "checked"));
  const ranked = eligible.map((i) => ({ i, s: matchScore(phrase, i.text) })).filter((x) => x.s >= 0.34).sort((a, b) => b.s - a.s);
  if (ranked.length === 0) throw new Error(`no ${pool === "any" ? "" : `${pool} `}item matching "${phrase}" on "${list.slug}"`);
  if (ranked.length > 1 && ranked[0].s === ranked[1].s) {
    throw new Error(`"${phrase}" is ambiguous on "${list.slug}": ${ranked.filter((x) => x.s === ranked[0].s).map((x) => x.i.text).join(" | ")} -- be more specific`);
  }
  return ranked[0].i;
}

// --- CLI ---

// This CLI's valueless flags -- passed to the shared parser so it doesn't swallow a following
// positional as their value (so `show --open <name>` works, not just `show <name> --open`).
const BOOL_FLAGS = new Set(["open", "all", "include-checked"]);

// When items are dropped from a channel-bound list, queue their posted mirror-message ids
// for the gateway to delete (else the message id is lost with the item and the channel
// orphans a stale entry). No-op for un-mirrored items (no mirrorMessageId).
function queueUnmirror(list: Checklist, dropped: Item[]): void {
  const ids = dropped.map((i) => i.mirrorMessageId).filter((x): x is string => !!x);
  if (ids.length) list.pendingUnmirror = [...(list.pendingUnmirror ?? []), ...ids];
}

function fmtList(l: Checklist): string {
  const open = l.items.filter((i) => !i.checked).length;
  return `${l.name} (${l.slug})  ${open}/${l.items.length} open${l.channelId ? `  → mirrors channel ${l.channelId}` : ""}`;
}

const USAGE = [
  "usage:",
  "  checklist-cli lists                          all your checklists",
  "  checklist-cli make <name> [--channel <id>]   create a checklist",
  "  checklist-cli show <name> [--open]            a checklist's items (--open hides checked-off ones)",
  "  checklist-cli add <name> <item…> [--due ISO]  add an open item (--due schedules a reminder you set)",
  "  checklist-cli check <name> <item…>            check an item off (fuzzy match within the list)",
  "  checklist-cli uncheck <name> <item…>          un-check it",
  "  checklist-cli remove <name> <item…>           delete an item",
  "  checklist-cli clear <name> [--all]            drop checked items (or --all to empty)",
  "  checklist-cli rm <name>                        delete a checklist",
  "  checklist-cli recreate <name>                  archive the list, start a fresh copy (same items, all unchecked)",
  "  checklist-cli set-category <name> <itemId> <category>   set/clear an item's Sort/Group category (by exact id)",
  "  checklist-cli find <phrase…> [--list <name>] [--include-checked]  ranked items matching a phrase (open-only by default; --include-checked adds done items for reverse-lookup)",
  "",
  "A checklist is things you COMPLETE (then clear). Aggregating notes -> a projects-cli project instead.",
].join("\n");

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positionals } = parseFlags(rest, BOOL_FLAGS);
  const P = CHECKLISTS_PATH;

  if (cmd === "lists") {
    const lists = readChecklists(P).filter((l) => !l.deleted);
    if (lists.length === 0) { console.log("(no checklists yet -- `checklist-cli make <name>`)"); return; }
    for (const l of lists.slice().sort((a, b) => a.slug.localeCompare(b.slug))) console.log(fmtList(l));
  } else if (cmd === "make") {
    if (!positionals[0]) throw new Error("usage: checklist-cli make <name> [--channel <id>]");
    const name = positionals.join(" ");
    const slug = slugify(name);
    const channelId = typeof flags.channel === "string" ? flags.channel : undefined;
    await mutate(P, (lists) => {
      if (lists.some((l) => l.slug === slug && !l.deleted)) throw new Error(`a checklist "${slug}" already exists`);
      if (lists.filter((l) => !l.deleted).length >= MAX_CHECKLISTS) throw new Error(`too many checklists (cap ${MAX_CHECKLISTS})`);
      const now = new Date().toISOString();
      // A same-slug rm-tombstone may still be draining its mirror messages in its OWN
      // channel -- leave it alone and push a fresh record. Coexistence is safe because
      // reconcile matches + drops by stable `id`, not slug (and `rm` filters by id too), so
      // the tombstone drains in its channel and is dropped independently. (Don't revive the
      // tombstone: its channelId + pendingUnmirror are bound to the OLD channel; re-pointing
      // or clearing them would strand those deletes and leak the old messages.)
      lists.push({ id: newItemId(), slug, name, ...(channelId ? { channelId } : {}), items: [], created: now, updated: now });
      return { lists, value: null };
    });
    console.log(`Created checklist "${slug}".`);
  } else if (cmd === "show") {
    if (!positionals[0]) throw new Error("usage: checklist-cli show <name> [--open]");
    // `--open` hides checked-off items, so "what do I have left?" (show --open) reads
    // differently from "show me the list" (show, which includes the done items).
    const openOnly = flags.open === true;
    const list = resolveList(readChecklists(P), positionals.join(" "));
    console.log(fmtList(list));
    const items = openOnly ? list.items.filter((i) => !i.checked) : list.items;
    if (openOnly && items.length === 0) console.log(list.items.length ? "  (nothing left -- all done ✅)" : "  (empty)");
    for (const i of items) console.log(`  [${i.checked ? "x" : " "}] ${i.text}${i.due ? `  (due ${i.due})` : ""}`);
  } else if (cmd === "add") {
    const name = positionals[0];
    const text = positionals.slice(1).join(" ").trim();
    if (!name || !text) throw new Error("usage: checklist-cli add <name> <item…> [--due ISO]");
    if (text.length > MAX_ITEM_TEXT) throw new Error(`item text is too long (${text.length} > ${MAX_ITEM_TEXT} chars) -- a checklist item should be short`);
    const due = typeof flags.due === "string" ? flags.due : undefined;
    if (due && Number.isNaN(new Date(due).getTime())) throw new Error(`invalid --due (want an ISO datetime): ${JSON.stringify(due)}`);
    const item = await mutate(P, (lists) => {
      const list = resolveList(lists, name);
      if (list.items.length >= MAX_ITEMS_PER_LIST) throw new Error(`"${list.slug}" is full (cap ${MAX_ITEMS_PER_LIST})`);
      const it: Item = { id: newItemId(), text, checked: false, ...(due ? { due } : {}), created: new Date().toISOString() };
      list.items.push(it);
      list.updated = new Date().toISOString();
      return { lists, value: it };
    });
    console.log(JSON.stringify({ added: true, id: item.id, due: item.due ?? null }));
  } else if (cmd === "check" || cmd === "uncheck") {
    const name = positionals[0];
    const phrase = positionals.slice(1).join(" ").trim();
    if (!name || !phrase) throw new Error(`usage: checklist-cli ${cmd} <name> <item…>`);
    const checked = cmd === "check";
    const res = await mutate(P, (lists) => {
      const list = resolveList(lists, name);
      const item = resolveItem(list, phrase, checked ? "open" : "checked"); // check an open item; uncheck a checked one
      item.checked = checked;
      if (checked) item.checkedAt = new Date().toISOString(); else delete item.checkedAt;
      list.updated = new Date().toISOString();
      return { lists, value: { slug: list.slug, text: item.text } };
    });
    console.log(JSON.stringify({ [checked ? "checked" : "unchecked"]: true, list: res.slug, item: res.text }));
  } else if (cmd === "remove") {
    const name = positionals[0];
    const phrase = positionals.slice(1).join(" ").trim();
    if (!name || !phrase) throw new Error("usage: checklist-cli remove <name> <item…>");
    const res = await mutate(P, (lists) => {
      const list = resolveList(lists, name);
      const item = resolveItem(list, phrase, "any"); // remove a checked or open item
      queueUnmirror(list, [item]);
      list.items = list.items.filter((i) => i.id !== item.id);
      list.updated = new Date().toISOString();
      return { lists, value: item.text };
    });
    console.log(JSON.stringify({ removed: true, item: res }));
  } else if (cmd === "clear") {
    if (!positionals[0]) throw new Error("usage: checklist-cli clear <name> [--all]");
    const all = flags.all === true;
    const n = await mutate(P, (lists) => {
      const list = resolveList(lists, positionals.join(" "));
      const before = list.items.length;
      const dropped = all ? list.items : list.items.filter((i) => i.checked);
      queueUnmirror(list, dropped);
      list.items = all ? [] : list.items.filter((i) => !i.checked);
      list.updated = new Date().toISOString();
      return { lists, value: before - list.items.length };
    });
    console.log(JSON.stringify({ cleared: n, mode: all ? "all" : "checked" }));
  } else if (cmd === "rm") {
    if (!positionals[0]) throw new Error("usage: checklist-cli rm <name>");
    const slug = await mutate(P, (lists) => {
      const list = resolveList(lists, positionals.join(" "));
      // Tombstone-if-draining, else drop by stable id (a same-slug tombstone draining alongside a
      // recreation isn't stranded) -- the shared retireList helper.
      return { lists: retireList(lists, list, new Date().toISOString()), value: list.slug };
    });
    console.log(JSON.stringify({ removed: slug }));
  } else if (cmd === "recreate") {
    if (!positionals[0]) throw new Error("usage: checklist-cli recreate <name>");
    const res = await mutate(P, (lists) => {
      const list = resolveList(lists, positionals.join(" "));
      const now = new Date().toISOString();
      // Fresh, all-open copies of the items -- same text/due, new ids, no completion
      // (checkedAt) or mirror (mirrorMessageId/mirrorChecked) state. The replacement keeps the
      // same slug/name/channel, so it IS the same list, just reset. Built from list.items
      // BEFORE the retire below mutates them.
      const items: Item[] = list.items.map((i) => ({ id: newItemId(), text: i.text, checked: false, ...(i.category ? { category: i.category } : {}), ...(i.due ? { due: i.due } : {}), created: now }));
      const fresh: Checklist = { id: newItemId(), slug: list.slug, name: list.name, ...(list.channelId ? { channelId: list.channelId } : {}), items, created: now, updated: now };
      // Retire the old (completed) list the same mirror-safe way `rm` does, then append the fresh
      // same-slug copy -- which coexists with a draining tombstone by design (matched by stable
      // id, not slug). retireList reads list.items (mirror ids) AFTER the copies above are built.
      return { lists: [...retireList(lists, list, now), fresh], value: { slug: fresh.slug, items: items.length } };
    });
    console.log(JSON.stringify({ recreated: res.slug, items: res.items }));
  } else if (cmd === "set-category") {
    // Set (or clear) one item's grouping category by EXACT id -- the Sort/Group write path
    // (home-bot spawns an agent that calls this per open item with the ids from its prompt).
    // By id, not fuzzy text: a bulk categorize must hit exactly the item it means. The label is
    // whitespace-collapsed and capped at MAX_CATEGORY (a heading, not prose); empty clears it.
    const name = positionals[0];
    const itemId = positionals[1];
    // Require the category ARGUMENT to be present (positionals.length >= 3), distinct from an
    // explicitly-empty "" which is the deliberate clear -- a dropped 3rd arg from a flailing model
    // must exit nonzero, not silently un-categorize (the run_cli "nonzero on misuse" invariant).
    if (!name || !itemId || positionals.length < 3) throw new Error("usage: checklist-cli set-category <name> <itemId> <category>  ('' clears)");
    const category = capCategory(positionals.slice(2).join(" "));
    const res = await mutate(P, (lists) => {
      const list = resolveList(lists, name);
      const item = list.items.find((i) => i.id === itemId);
      if (!item) throw new Error(`no item ${JSON.stringify(itemId)} on "${list.slug}"`);
      if (category) item.category = category; else delete item.category;
      list.updated = new Date().toISOString();
      return { lists, value: { slug: list.slug, category: item.category ?? null } };
    });
    console.log(JSON.stringify({ categorized: res.slug, itemId, category: res.category }));
  } else if (cmd === "find") {
    const listName = typeof flags.list === "string" ? flags.list : undefined;
    const phrase = positionals.join(" ").trim();
    if (!phrase) throw new Error("usage: checklist-cli find <phrase…> [--list <name>] [--include-checked]");
    const lists = readChecklists(P);
    const scope = listName ? resolveList(lists, listName).slug : undefined;
    const includeChecked = flags["include-checked"] === true;
    const hits = findOpen(lists, phrase, scope, includeChecked);
    if (hits.length === 0) { console.log("(no items match)"); return; }
    for (const h of hits) console.log(`${h.score.toFixed(2)}  ${h.listName} · ${h.item.text}${h.item.checked ? "  ✓" : ""}`);
  } else {
    console.error(USAGE);
    process.exit(cmd ? 1 : 2); // nonzero even with NO subcommand: exit-0-with-usage made run_cli report ok:true, so a model that misinvoked (cmd in stdin, no args) looped on the success-looking usage instead of self-correcting
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err: unknown) => {
    console.error(`checklist-cli: ${(err as Error).message}`);
    process.exit(1);
  });
}
