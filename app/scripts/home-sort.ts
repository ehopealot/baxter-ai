// Sort/Group for the home checklist surface: categorize a list's OPEN items into grocery-aisle
// groups. The DO sends a { kind:"sort-list", listId } COMMAND down the checklist link (like
// calendar-refresh); home-bot dispatches it here.
//
// The home surface is a no-LLM sync loop by design (compose: "never runs ... an LLM (hard
// invariant)") -- so this does NOT spawn an agent run. It makes ONE scoped OpenRouter
// chat/completions call (the same kind of outbound HTTPS home already does for calendar polling),
// asks for a JSON id->category map, and applies it to the store directly. No codapi, no agent
// loop, no set-category round-trip. The model call is injected (default: makeModelCategorizer; a
// fake in tests), so the resolve/gather/parse/apply/republish path is hermetically testable.
import { readChecklists, mutate, capCategory } from "./checklist-store.ts";
import type { Item } from "./checklist-store.ts";
import { cleanForPromptLine } from "./transcript.ts";
import type { FetchLike } from "./calendar-cli.ts";

export interface SortListPayload { kind: "sort-list"; listId: string; }

// A command frame is only trusted from the SigV4-verified DO link, but validate the shape here
// the same way home-link.ts's isIntentLike does. `listId` is the stable store id (not the slug).
export function isSortListCommand(p: unknown): p is SortListPayload {
  return typeof p === "object" && p !== null
    && (p as { kind?: unknown }).kind === "sort-list"
    && typeof (p as { listId?: unknown }).listId === "string";
}

// The categorization request. Item text is family-authored, so each value goes through
// cleanForPromptLine (single-line, marker-neutralized) -- an item can't forge a prompt line or
// smuggle a trigger marker. `existing` are the group labels already in use on the list: the model
// is told to REUSE them when an item fits, so a re-sort drops new items into the current groups
// rather than inventing near-duplicates. Only the items in `toSort` (the uncategorized ones) are
// listed -- already-grouped items are never sent, so they can't be moved.
export function buildSortPrompt(listName: string, toSort: Item[], existing: string[]): string {
  const rows = toSort.map((i) => `${i.id}: ${cleanForPromptLine(i.text)}`).join("\n");
  const lines = [
    `Group the following items on the checklist "${cleanForPromptLine(listName)}" into clear grocery-aisle-style categories (e.g. Produce, Dairy, Frozen, Pantry, Bakery, Meat, Household). Assign each item one short Title Case category.`,
  ];
  if (existing.length) {
    lines.push(`These groups already exist on the list -- REUSE the exact label when an item fits one, and only invent a new group when none do: ${existing.map((c) => cleanForPromptLine(c)).join(", ")}.`);
  }
  lines.push("", "Items to categorize (id: text):", rows, "",
    `Reply with ONLY a JSON array, one object per item: [{"id":"<id>","category":"<label>"}]. No prose, no code fences, no extra keys. Use the exact ids above.`);
  return lines.join("\n");
}

// Parse the model's reply into {id, category} pairs, defensively: pull the first JSON array out
// (models sometimes wrap it in prose or ``` fences), keep only objects with a string id that is
// a KNOWN open item and a non-empty string category, first-wins on a duplicate id. Anything
// malformed is dropped, never thrown -- a garbled reply just categorizes fewer items.
export function parseCategories(raw: string, validIds: Set<string>): Array<{ id: string; category: string }> {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ id: string; category: string }> = [];
  const seen = new Set<string>();
  for (const e of parsed) {
    if (typeof e !== "object" || e === null) continue;
    const id = (e as { id?: unknown }).id;
    const category = (e as { category?: unknown }).category;
    if (typeof id !== "string" || typeof category !== "string") continue;
    if (!validIds.has(id) || seen.has(id)) continue;
    const c = category.trim();
    if (!c) continue;
    seen.add(id);
    out.push({ id, category: c });
  }
  return out;
}

// The injected categorizer: home-bot supplies makeModelCategorizer; tests a fake. `toSort` is the
// UNCATEGORIZED open items; `existing` the labels already on the list (to reuse).
export type Categorizer = (listName: string, toSort: Item[], existing: string[]) => Promise<Array<{ id: string; category: string }>>;

// The default categorizer: one OpenRouter chat/completions call (temperature 0 for stable
// grouping). Targets OpenRouter directly rather than the harness runner -- this is a single
// scoped completion, not an agent turn, and the operator runs the openrouter harness. Throws if
// the model isn't configured or the call fails; sortListCommand swallows + logs it.
export function makeModelCategorizer(env: NodeJS.ProcessEnv, fetchImpl: FetchLike): Categorizer {
  return async (listName, toSort, existing) => {
    const apiKey = env.OPENROUTER_API_KEY;
    const model = env.BAXTER_MODEL_OVERRIDE || env.OPENROUTER_MODEL;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set (home Sort needs a model)");
    if (!model) throw new Error("OPENROUTER_MODEL is not set (home Sort needs a model)");
    const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      // Bounded like every other outbound call on this surface (calendar polling, chat-title): a
      // hung route must not leave this fire-and-forget promise pending for undici's ~300s default
      // -- the abort rejects into sortListCommand's catch and is logged. max_tokens scales with
      // the list (one small JSON object per item) so a normal list is never truncated.
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: Math.min(toSort.length * 60 + 200, 8000),
        messages: [{ role: "user", content: buildSortPrompt(listName, toSort, existing) }],
      }),
    });
    if (!res.ok) throw new Error(`categorize call failed: HTTP ${res.status}`);
    const data = await res.json() as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }> };
    const raw = data.choices?.[0]?.message?.content;
    const parsed = parseCategories(typeof raw === "string" ? raw : "", new Set(toSort.map((i) => i.id)));
    // Parse FIRST: a length-truncated reply has no closing `]` so it parses to [], which would
    // otherwise log as "produced no categories" (blaming the model, not the cap). Only blame
    // truncation when the parse actually came up empty -- so a reply that ended exactly at the
    // cap with valid JSON still counts. The throw lands in sortListCommand's catch and is logged.
    if (parsed.length === 0 && data.choices?.[0]?.finish_reason === "length") {
      throw new Error("categorize reply truncated at max_tokens (list too large to group in one call)");
    }
    return parsed;
  };
}

// Handle a sort-list command: resolve the list by stable id, gather OPEN items, categorize them,
// and write the categories back through mutate() (OPEN items only, whitespace-collapsed + capped
// at MAX_CATEGORY). onApplied republishes the now-grouped view. Every moot/bad case (malformed
// payload, unknown/deleted list, no open items, empty model result) and any error is
// swallowed+logged -- never thrown -- so a bad command can't crash the standing home surface.
export async function sortListCommand(
  payload: unknown,
  checklistsPath: string,
  categorize: Categorizer,
  onApplied: () => void,
  logFn: (m: string) => void,
  logErrFn: (m: string) => void,
): Promise<void> {
  if (!isSortListCommand(payload)) { logErrFn("home: ignoring malformed sort-list command payload"); return; }
  try {
    const list = readChecklists(checklistsPath).find((l) => l.id === payload.listId && !l.deleted);
    if (!list) { logFn(`home: sort-list for unknown list ${payload.listId} -- ignored`); return; }
    const open = list.items.filter((i) => !i.checked);
    // Only categorize UNCATEGORIZED open items -- an already-grouped item is never re-sent (or
    // re-written), so a re-sort deterministically leaves placed items where they are and just
    // files the new ones. The existing group labels go to the model as context to reuse.
    const toSort = open.filter((i) => !(i.category ?? "").trim());
    if (toSort.length === 0) { logFn(`home: sort-list on "${list.slug}" -- nothing uncategorized to group`); return; }
    // Offer EVERY existing label (incl. ones currently only on checked items) so a new item joins
    // the original group rather than a near-duplicate -- checked items keep their category, uncheck
    // and recreate restore it, so a checked-only "Dairy" must still be reusable.
    const existing = [...new Set(list.items.map((i) => (i.category ?? "").trim()).filter(Boolean))].sort();

    const assignments = await categorize(list.name, toSort, existing);
    if (assignments.length === 0) { logFn(`home: sort-list on "${list.slug}" produced no categories`); return; }
    const byId = new Map(assignments.map((a) => [a.id, capCategory(a.category)]));

    let changed = 0;
    await mutate(checklistsPath, (lists) => {
      const l = lists.find((x) => x.id === payload.listId && !x.deleted);
      if (l) {
        for (const it of l.items) {
          if (it.checked) continue;                 // only OPEN items
          if ((it.category ?? "").trim()) continue; // never re-categorize an already-grouped item (determinism)
          const cat = byId.get(it.id);
          if (cat && it.category !== cat) { it.category = cat; changed++; }
        }
        if (changed) l.updated = new Date().toISOString();
      }
      return { lists, value: null };
    });
    if (changed) onApplied(); // republish the grouped view
    logFn(`home: sorted "${list.slug}" into groups (${changed} item${changed === 1 ? "" : "s"})`);
  } catch (err) {
    logErrFn(`home: sort-list command failed: ${(err as Error).message}`);
  }
}
