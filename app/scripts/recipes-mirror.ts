// Recipes mirror for the family-home surface (spec: docs/superpowers/plans/2026-08-06-
// home-recipes.md Task C1; rationale: docs/superpowers/specs/2026-08-06-home-recipes-
// design.md). Pure/injectable helpers wired into the EXISTING home daemon (home-bot.ts)
// as a SECOND HomeLink connection alongside the checklist link -- no new compose
// profile/process (the design doc's "Daemon placement" note: a read-only publish surface
// with no runAgent/ChannelDispatcher to isolate is structurally like the checklist link,
// not like chat/sms's separate processes).
//
// Recipes are READ-ONLY: there is no down-direction intent traffic at all (no create/
// edit/delete from home), so unlike chat-bot.ts this file has no intent type, no
// isIntentLike validator, no handleIntent, no dispatcher/runAgent wiring -- home-bot.ts's
// own onPull registration for this link never calls onIntent either. Split into its own
// file (rather than folded into home-bot.ts directly, the way home-bot.ts folds its OWN
// fs.watch->changed push) purely to keep home-bot.ts's daemon-lifecycle file focused; each
// export below is pure/injectable and easy to pin in isolation, same rationale chat-bot.ts
// gives for keeping ITS watch+digest logic in one file (there, the shared-store-lock
// concern chat-transcript.ts's own lock is; here, there is no comparable concern to weigh
// against the split).
//
// Mirrors chat-bot.ts's three link-support exports field-for-field:
//   - chatIndexVersion      -> recipesIndexVersion   (canonicalize + sha256 digest)
//   - watchChats            -> watchRecipes           (recursive fs.watch + debounce)
//   - signedChatLinkConnect -> signedRecipesLinkConnect (SigV4 dial, service "home")
import { mkdirSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import type { WebSocketLike } from "./home-link.ts";
import type { HomeKeys } from "./home-mirror.ts";
import { listRecipes, removeRecipe, type RecipeSummary } from "./recipes-store.ts";
import { logErr } from "./runtime.ts";

// ---------- recipes index digest (this link's own "viewVersion") ----------

// A LOCAL copy of chat-bot.ts's own `canonicalize` (itself a local copy of home-mirror.ts's
// canonicalize/viewVersion) -- same "define locally per domain, don't cross-import"
// discipline every one of these sibling digests follows (see chat-bot.ts's own comment on
// its copy for the full rationale): deterministic serialization, sort object keys
// recursively, preserve array order. Any content change (a recipe saved/edited/removed via
// recipes-cli -- see recipes-store.ts's saveRecipe/removeRecipe) changes the digest, which
// is exactly what the worker's reduceHello/reduceChanged (recipes-link.ts) compare against
// their own stored `recipesIndexVersion` to decide staleness.
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",") + "}";
}
export function recipesIndexVersion(index: RecipeSummary[] = listRecipes()): string {
  return createHash("sha256").update(canonicalize(index)).digest("hex");
}

// ---------- SigV4-signed recipes-link connect ----------

// Mirrors chat-bot.ts's signedChatLinkConnect exactly (itself mirroring home-bot.ts's
// signedLinkConnect) but dials /recipes-link -- a DEDICATED third socket
// (recipesLinkUpgrade/acceptRecipesLink on the worker side), separate from both the
// checklist /link and chat's own /chat-link. Signed fresh on every dial (x-amz-date skew
// window; see signedLinkConnect's header comment for why this must be a per-call closure,
// not a construction-time signature). Same credential + service ("home") the other two
// links use.
export function signedRecipesLinkConnect(
  keys: HomeKeys,
  makeSocket: (url: string, headers: Record<string, string>) => WebSocketLike =
    (url, headers) => new WebSocket(url, { headers }) as unknown as WebSocketLike,
): () => Promise<WebSocketLike> {
  const aws = new AwsClient({ accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, region: "auto", service: "home" });
  const linkUrl = `${keys.endpoint.replace(/\/+$/, "")}/recipes-link`;
  const wssUrl = linkUrl.replace(/^http/, "ws");
  return async () => {
    const signed = await aws.sign(linkUrl, { method: "GET" });
    return makeSocket(wssUrl, {
      authorization: signed.headers.get("authorization") ?? "",
      "x-amz-date": signed.headers.get("x-amz-date") ?? "",
    });
  };
}

// ---------- remove-recipe command (home /recipes trash button) ----------

// The ONE down-direction command the recipes surface handles. Recipes are otherwise
// read-only (see this file's header), but the home /recipes page now has a per-recipe
// delete button, and delete is a DETERMINISTIC, pure operation -- no agent run -- so it
// rides a fire-and-forget `command` exactly like sort-list (home-sort.ts's
// sortListCommand), NOT the chat/agent path the ADD button uses. It deletes the file and
// lets watchRecipes' own fs.watch on RECIPES_DIR push the republish up the recipes link,
// identical to any `recipes-cli rm` from another surface -- so there is no explicit
// checkForChanges here (and no need to reach the recipes link's wiring from the checklist
// link this command arrives on). The payload is validated defensively: link-protocol only
// guarantees `command` is an object, so a malformed/empty slug is logged and ignored, never
// thrown (a command has no ack on this wire, same swallow+log posture as sortListCommand).
function isRemoveRecipeCommand(p: unknown): p is { kind: "remove-recipe"; slug: string } {
  return !!p && typeof p === "object"
    && (p as { kind?: unknown }).kind === "remove-recipe"
    && typeof (p as { slug?: unknown }).slug === "string"
    && (p as { slug: string }).slug.trim().length > 0;
}
export async function removeRecipeCommand(
  payload: unknown,
  dir: string,
  logFn: (m: string) => void,
  logErrFn: (m: string) => void,
  remove: (slug: string, dir: string) => Promise<string | null> = removeRecipe,
): Promise<void> {
  if (!isRemoveRecipeCommand(payload)) { logErrFn("home: ignoring malformed remove-recipe command payload"); return; }
  try {
    const removed = await remove(payload.slug, dir);
    if (removed) logFn(`home: removed recipe "${removed}" (home delete button)`);
    else logFn(`home: remove-recipe for unknown slug "${payload.slug}" -- ignored`);
  } catch (err) {
    logErrFn(`home: remove-recipe failed: ${(err as Error).message}`);
  }
}

// ---------- fs.watch(RECIPES_DIR) -> changed ----------

// Same value chat-bot.ts's/home-bot.ts's own WATCH_DEBOUNCE_MS uses -- a courtesy fold of
// repeated fs.watch events into one onChange() call, not a correctness requirement
// (recipes-link.ts's reduceChanged, worker side, is itself a no-op when the carried
// viewVersion hasn't moved). A LOCAL copy, like every sibling surface's own copy of this
// same literal, rather than an import from chat-bot.ts/home-bot.ts -- see those files'
// own WATCH_DEBOUNCE_MS for the same "define locally, don't cross-import" discipline (and,
// here, it also sidesteps a circular import: home-bot.ts imports FROM this file). Exported
// so tests can compute boundaries off this value rather than a copied literal.
export const WATCH_DEBOUNCE_MS = 200;

// Re-anchor the process's liveness with a dedicated ref'd fallback timer if the watch
// itself dies -- mirrors chat-bot.ts's/home-bot.ts's own keepAliveFallback.
function keepAliveFallback(): ReturnType<typeof setInterval> {
  return setInterval(() => {}, 2 ** 31 - 1);
}

// Watch RECIPES_DIR (recursively -- like watchChats's own CHATS_DIR watch: one JSON file
// per recipe under this dir, and any change under it is a candidate `changed` trigger --
// a save/edit/delete via recipes-cli from ANY surface) and call onChange, leading-edge
// folded per WATCH_DEBOUNCE_MS. No basename filter (mirrors watchChats, not
// watchChecklistStore's single-file basename match): every change under the tree is a
// candidate, and a redundant onChange costs nothing (the worker's reduceChanged is the
// actual no-op gate on a digest that hasn't moved). `watchFn`/`logErrFn` are injectable
// seams (default: the real `node:fs` watch / runtime.ts's logErr), mirroring
// watchChats/watchChecklistStore.
export function watchRecipes(
  dir: string,
  onChange: () => void,
  watchFn: typeof watch = watch,
  logErrFn: (m: string) => void = logErr,
): { close(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Shared by both failure paths below, same discipline as watchChats/watchChecklistStore.
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  // Gates both handlers below against an event arriving after close() -- neither
  // fs.watch's raw listener nor an EventEmitter's 'error' is suppressed by close() just
  // because the caller tore the watcher down. See watchChecklistStore's own comment
  // (home-bot.ts) for the full rationale (unchanged here).
  let closed = false;
  try {
    mkdirSync(dir, { recursive: true });
    const watcher = watchFn(dir, { recursive: true }, (_event, _filename) => {
      if (closed) return;
      if (timer !== null) return; // leading-edge: a call is already pending, fold this one in
      timer = setTimeout(() => { timer = null; onChange(); }, WATCH_DEBOUNCE_MS);
      timer.unref?.();
    });
    watcher.on("error", (err: Error) => {
      if (closed) return;
      logErrFn(`recipes: recipes-dir watch died (${err.message}) -- local edits won't push a 'changed' notice until restart`);
      if (keepAlive === null) keepAlive = keepAliveFallback(); // de-dupe: only the first error needs to re-anchor
    });
    return { close: () => {
      closed = true;
      watcher.close();
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (keepAlive !== null) clearInterval(keepAlive);
    } };
  } catch (err) {
    logErrFn(`recipes: could not watch the recipes dir (${(err as Error).message}) -- local edits won't push a 'changed' notice until the next reconnect`);
    keepAlive = keepAliveFallback();
    return { close: () => { if (keepAlive !== null) clearInterval(keepAlive); } };
  }
}
