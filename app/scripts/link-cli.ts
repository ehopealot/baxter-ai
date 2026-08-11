#!/usr/bin/env node
// link-cli: resolves a checklist / chat / recipe to its home.bax.bot URL and prints it.
// Read-only (reads STATE_DIR stores only; no network, no creds). Single <type> <key>
// dispatch; bare URL on stdout by default, --json for {type,url,...}. Exits nonzero on any
// misuse or unresolved lookup (the run_cli invariant shared by every CLI here). The
// dispatch at the bottom is import-guarded so importing this file doesn't run it.
import { pathToFileURL } from "node:url";
import { parseFlags } from "./cli-flags.ts";
import { readChecklists } from "./checklist-store.ts";
import { resolveList } from "./checklist-cli.ts";
import { listChats, isValidChatId } from "./chat-transcript.ts";
import { readRecipe, toSlug } from "./recipes-store.ts";

const DEFAULT_BASE = "https://home.bax.bot";

const TYPE_ALIASES: Record<string, "list" | "chat" | "recipe"> = {
  list: "list", lists: "list",
  chat: "chat", chats: "chat",
  recipe: "recipe", recipes: "recipe",
};

const USAGE = [
  "usage:",
  "  link-cli <type> <name|id|slug> [--json]",
  "    list|lists    <name>    a checklist (fuzzy name -> slug)",
  "    chat|chats    <id>      a home chat (wc-<n>)",
  "    recipe|recipes <slug>   a recipe (by slug)",
  "  --json: emit {type,url,...} instead of the bare URL",
  "  HOME_BASE_URL overrides the default https://home.bax.bot",
  "Prints the home.bax.bot URL for the object. Exits 1 if not found/ambiguous, 2 on misuse.",
].join("\n");

// Operator-only origin (the run's Bash(link-cli *) grant can't set env). Validated
// authoritatively via new URL() so a value carrying a path/query/fragment/userinfo is
// rejected rather than smuggled into a link -- matches data-cli/skills-cli's posture.
// Empty-means-unset (||, not ??): an env_file `HOME_BASE_URL=` is the empty string, not
// nullish, and new URL("") would throw -- so treat falsy as unset, like skills-cli.
function baseUrl(): string {
  const raw = (process.env.HOME_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  let u: URL;
  try { u = new URL(raw); } catch {
    throw new Error(`HOME_BASE_URL must be a bare http(s) origin (scheme://host[:port], no path/query/userinfo): ${JSON.stringify(raw)}`);
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
    throw new Error(`HOME_BASE_URL must be a bare http(s) origin (scheme://host[:port], no path/query/userinfo): ${JSON.stringify(raw)}`);
  }
  return u.origin;
}

function emit(json: boolean, obj: { type: string; url: string } & Record<string, unknown>): void {
  console.log(json ? JSON.stringify(obj) : obj.url);
}

async function main(): Promise<void> {
  const { positionals, flags } = parseFlags(process.argv.slice(2), new Set(["json"]));
  const type = positionals[0];
  const key = positionals.slice(1).join(" ").trim();
  const kind = type && Object.hasOwn(TYPE_ALIASES, type) ? TYPE_ALIASES[type] : undefined;
  if (!kind) { console.error(USAGE); process.exit(2); } // unknown type OR no subcommand
  if (!key) { console.error(`usage: link-cli ${kind} <${kind === "chat" ? "id" : kind === "recipe" ? "slug" : "name"}>`); process.exit(2); }

  const base = baseUrl();
  const json = flags.json === true;

  if (kind === "list") {
    // resolveList filters tombstoned lists and throws (-> nonzero) on no-match/ambiguous tie.
    const list = resolveList(readChecklists(), key);
    emit(json, { type: "list", url: `${base}/l/${encodeURIComponent(list.slug)}`, slug: list.slug, name: list.name });
  } else if (kind === "chat") {
    if (!isValidChatId(key)) { console.error(`invalid chat id: ${key}`); process.exit(1); }
    const chat = listChats().find((c) => c.id === key); // listChats() already excludes deletedAt tombstones
    if (!chat) { console.error(`no such chat: ${key}`); process.exit(1); }
    emit(json, { type: "chat", url: `${base}/chats/${encodeURIComponent(chat.id)}`, id: chat.id, title: chat.title });
  } else {
    // recipe -- emit the CANONICAL slug (readRecipe resolves via toSlug internally, and
    // recipes-cli list/show/save all use toSlug too), so a title-shaped input still yields
    // a valid /r/<slug> URL rather than the raw key. readRecipe(key) (not readRecipe(slug))
    // so an all-punctuation key throws "invalid recipe slug: <raw>" naming the input, not
    // the transformed empty string -- toSlug is idempotent so resolution is identical.
    const slug = toSlug(key);
    const recipe = readRecipe(key);
    if (!recipe) { console.error(`no such recipe: ${key}`); process.exit(1); }
    emit(json, { type: "recipe", url: `${base}/r/${encodeURIComponent(slug)}`, slug, title: recipe.title });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err: unknown) => {
    console.error(`link-cli: ${(err as Error).message}`);
    process.exit(1);
  });
}
