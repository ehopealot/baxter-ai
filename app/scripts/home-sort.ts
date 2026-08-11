// Sort/Group for the home checklist surface: categorize a list's OPEN items into grocery-aisle
// groups. The DO sends a { kind:"sort-list", listId } COMMAND down the checklist link (like
// calendar-refresh); home-bot dispatches it here. Rather than parse a model's free-form output,
// the agent run itself calls `checklist-cli set-category` per item -- those store writes trigger
// home-bot's watcher, which republishes the now-grouped view. So this file only builds the
// prompt and spawns the run through an INJECTED runner (default: a runAgent spawn in home-bot;
// a fake in tests), keeping the orchestration + prompt hermetically testable.
import { readChecklists } from "./checklist-store.ts";
import type { Checklist, Item } from "./checklist-store.ts";
import { cleanForPromptLine } from "./transcript.ts";

export interface SortListPayload { kind: "sort-list"; listId: string; }

// A command frame is only trusted from the SigV4-verified DO link, but validate the shape here
// the same way home-link.ts's isIntentLike does -- a drifted/garbled payload must be ignored,
// not fed to a run. `listId` is the stable store id (not the mutable slug), matching the DO side.
export function isSortListCommand(p: unknown): p is SortListPayload {
  return typeof p === "object" && p !== null
    && (p as { kind?: unknown }).kind === "sort-list"
    && typeof (p as { listId?: unknown }).listId === "string";
}

// The prompt for a Sort/Group run. Item text is family-authored, so every value goes through
// cleanForPromptLine (single-line, marker-neutralized) -- an item can't forge a prompt line or
// smuggle a trigger marker into the run. The agent is told to categorize by calling the CLI (the
// bare `checklist-cli` shim CORE_TOOLS already grants), using the EXACT item ids listed.
export function buildSortPrompt(list: Checklist, open: Item[]): string {
  const rows = open.map((i) => `- ${i.id}  ${cleanForPromptLine(i.text)}`).join("\n");
  return [
    `Organize the checklist "${cleanForPromptLine(list.name)}" into a few clear category groups (grocery-aisle style, e.g. Produce, Dairy, Frozen, Pantry, Bakery, Meat, Household) so the family can work through it group by group.`,
    "",
    "Open items (id then text):",
    rows,
    "",
    "For EACH item above, pick a short Title Case category label (one or two words) and save it by running, once per item:",
    `  checklist-cli set-category ${list.slug} <itemId> <category>`,
    "",
    "Use the exact item id shown. Put similar items under the same label and keep the labels consistent across the list. Do NOT add, remove, check, rename, or reword any item. When every open item has a category, you are done.",
  ].join("\n");
}

// The injected run spawner: home-bot supplies a runAgent-backed default; tests a fake.
export type SortRunner = (prompt: string, slug: string, listId: string) => Promise<void>;

// Handle a sort-list command: resolve the list by stable id, gather its OPEN items, and spawn
// the run. Every moot/bad case is swallowed + logged (never thrown), mirroring
// applyMembersCommand/applyCalendarFeedsCommand -- a bad or stale command must not crash the
// standing home surface. An unknown/deleted list, or one with no open items, is a logged no-op.
export async function sortListCommand(
  payload: unknown,
  checklistsPath: string,
  runSort: SortRunner,
  logFn: (m: string) => void,
  logErrFn: (m: string) => void,
): Promise<void> {
  if (!isSortListCommand(payload)) { logErrFn("home: ignoring malformed sort-list command payload"); return; }
  try {
    const list = readChecklists(checklistsPath).find((l) => l.id === payload.listId && !l.deleted);
    if (!list) { logFn(`home: sort-list for unknown list ${payload.listId} -- ignored`); return; }
    const open = list.items.filter((i) => !i.checked);
    if (open.length === 0) { logFn(`home: sort-list on "${list.slug}" has no open items to group`); return; }
    await runSort(buildSortPrompt(list, open), list.slug, list.id);
  } catch (err) {
    logErrFn(`home: sort-list command failed: ${(err as Error).message}`);
  }
}
