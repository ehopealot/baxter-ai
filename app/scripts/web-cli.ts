#!/usr/bin/env node
// web-cli: credential-less web access for the agent run -- `fetch <url>` (HTTP GET
// + HTML->text) and `search <query>` (a self-hosted SearXNG JSON API). Reaches the
// net from the daemon container; holds no secret and writes nothing. Raw fetch, no
// deps. The pure helpers are exported for tests; the CLI dispatch at the bottom is
// guarded so importing this file (e.g. from a test) doesn't execute it.
import { pathToFileURL } from "node:url";
import { readCapped } from "./http-util.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DEFAULT_MAX_BYTES = 200 * 1024;
const FETCH_TIMEOUT_MS = 20000;

// SearXNG search backend. SEARXNG_URL is fixed by the environment (never a
// model-supplied argument), defaulting to the compose service alias -- mirrors
// code-cli's CODAPI_URL. Because the host is fixed + keyless, `search` needs no
// guardUrl (the fixed internal host is exactly what guardUrl blocks); the RESULT
// urls are text the model later `fetch`es, which re-guards them there.
const SEARXNG_URL = process.env.SEARXNG_URL || "http://searxng:8080";
const SEARCH_MAX_BYTES = 1024 * 1024; // 1 MB cap on the JSON response
const SEARCH_MAX_RESULTS = Math.max(1, Number(process.env.SEARXNG_MAX_RESULTS) || 8);

// --- pure helpers (exported for tests) ---

// Refuse non-http(s) schemes and obvious internal targets. NOT full SSRF
// protection -- a hostname that RESOLVES to a private IP still passes -- which is
// the same accepted residual as the browser CLIs (see app/CLAUDE.md's note on
// internal reachability). Returns the parsed URL or throws.
export function guardUrl(raw: unknown): URL {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`only http/https URLs are allowed (got ${u.protocol || "no scheme"})`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const internal =
    host === "localhost" ||
    host === "codapi" ||
    host === "::1" ||
    host === "::" ||
    host.startsWith("::ffff:") || // IPv4-mapped IPv6 (::ffff:127.0.0.1 routes to 127.0.0.1) -- refuse wholesale
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    // Anchor each IPv4 range to a full dotted quad: the URL parser normalizes any
    // real IPv4 literal (incl. bare "0"/hex/octal) to d.d.d.d, so this matches the
    // literals exactly without catching public domains like 0.gravatar.com / 10.com.
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    /^0\.\d+\.\d+\.\d+$/.test(host) || // 0.0.0.0/8
    /^10\.\d+\.\d+\.\d+$/.test(host) ||
    /^192\.168\.\d+\.\d+$/.test(host) ||
    /^169\.254\.\d+\.\d+$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host) ||
    // IPv6 ULA (fc00::/7) + link-local (fe80::/10) -- only for IPv6 literals (they
    // contain ":"), so a normal domain like "fc-barcelona.com" isn't caught.
    (host.includes(":") && (/^f[cd]/i.test(host) || /^fe[89ab]/i.test(host)));
  if (internal) throw new Error(`refusing to fetch an internal/loopback host: ${host}`);
  return u;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: unknown): string {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m: string, e: string) => {
    if (Object.hasOwn(NAMED_ENTITIES, e)) return NAMED_ENTITIES[e];
    let code: number | undefined;
    if (/^#x/i.test(e)) code = parseInt(e.slice(2), 16);
    else if (/^#/.test(e)) code = parseInt(e.slice(1), 10);
    if (code !== undefined && Number.isFinite(code)) {
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return m; // unknown named entity -> leave as-is
  });
}

// Convert HTML to readable text: drop script/style/head noise, turn block-ish
// close tags into newlines, strip remaining tags, decode entities, collapse
// whitespace. Not a full renderer -- JS-heavy pages need playwright-cli.
export function htmlToText(html: unknown): string {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template|svg|head)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|ul|ol|table|blockquote)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v\r]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

export function extractTitle(html: unknown): string {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

// --- network + CLI (not exported) ---

// Read a response body but never buffer more than hardMax bytes (a huge page
// can't OOM the daemon). Returns { text, truncated }.
// readCapped moved to ./http-util.ts (shared with data-cli + skills-cli).

interface HttpGetResult {
  status: number;
  finalUrl: string;
  contentType: string;
  text: string;
  truncated: boolean;
}

async function httpGet(url: string, hardMax: number): Promise<HttpGetResult> {
  const u = guardUrl(url);
  const controller = new AbortController();
  // One timer covering BOTH the fetch AND the body read: aborting the signal
  // rejects reader.read(), so a server that dribbles the body can't stall past
  // FETCH_TIMEOUT_MS. Cleared only after readCapped finishes.
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(u, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*" },
    });
    guardUrl(res.url || u.toString()); // re-check the final URL after redirects
    const { text, truncated } = await readCapped(res, hardMax);
    return { status: res.status, finalUrl: res.url || u.toString(), contentType: res.headers.get("content-type") || "", text, truncated };
  } catch (err) {
    throw new Error((err as Error).name === "AbortError" || controller.signal.aborted ? `request timed out after ${FETCH_TIMEOUT_MS}ms` : (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

async function cmdFetch(url: string, flags: Record<string, string | undefined>): Promise<void> {
  const maxBytes = Number(flags["max-bytes"]) > 0 ? Number(flags["max-bytes"]) : DEFAULT_MAX_BYTES;
  const r = await httpGet(url, maxBytes);
  const isHtml = /html|xml/i.test(r.contentType) || /^\s*<(!doctype|html|head|body)/i.test(r.text);
  let out = `URL: ${r.finalUrl}\nStatus: ${r.status}\n`;
  if (isHtml) {
    const title = extractTitle(r.text);
    if (title) out += `Title: ${title}\n`;
    out += `\n${htmlToText(r.text)}`;
  } else {
    out += `\n${r.text}`;
  }
  if (r.truncated) out += `\n\n[truncated at ${maxBytes} bytes -- refine or use playwright-cli for the full page]`;
  console.log(out);
}

// --- search (SearXNG JSON API) ---

// Collapse a possibly-HTML snippet to one clean line: strip tags, decode entities,
// collapse whitespace. SearXNG `content`/`title` are usually plain text but can
// carry stray entities/markup.
function collapse(s: unknown): string {
  return decodeEntities(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function snippet(s: unknown): string {
  const t = collapse(s);
  return t.length > 300 ? t.slice(0, 297) + "..." : t;
}

// Format a parsed SearXNG JSON response into compact agent-readable text. Pure +
// exported for tests. Defensive about field presence and about `answers` being
// either plain strings or {answer,url} objects (the shape varies by SearXNG version).
export function formatSearchResults(json: unknown, query: string, max: number = SEARCH_MAX_RESULTS): string {
  const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const results = Array.isArray(obj.results) ? obj.results : [];
  const rawAnswers = Array.isArray(obj.answers) ? obj.answers : [];
  const rawSuggestions = Array.isArray(obj.suggestions) ? obj.suggestions : [];

  const answers = rawAnswers
    .map((a) => (typeof a === "string" ? a : a && typeof a === "object" ? (a as Record<string, unknown>).answer : ""))
    .map((a) => collapse(a))
    .filter(Boolean);

  const out: string[] = [`Search: ${query}`];
  for (const a of answers.slice(0, 3)) out.push(`Answer: ${a}`);

  const top = results.slice(0, Math.max(1, max));
  if (top.length === 0) {
    out.push("", "No results. Try different search terms, or fetch a page directly with `web-cli fetch <url>`.");
    return out.join("\n");
  }
  out.push("", `${top.length} result${top.length === 1 ? "" : "s"} from SearXNG:`);
  top.forEach((r, i) => {
    const rr = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
    const title = collapse(rr.title) || "(untitled)";
    const url = typeof rr.url === "string" ? rr.url : "";
    const content = snippet(rr.content);
    out.push("", `${i + 1}. ${title}`);
    if (url) out.push(`   ${url}`);
    if (content) out.push(`   ${content}`);
  });
  const sugg = rawSuggestions.map((s) => collapse(s)).filter(Boolean).slice(0, 6);
  if (sugg.length) out.push("", `Related searches: ${sugg.join("; ")}`);
  return out.join("\n");
}

export interface SearchDeps {
  fetch?: (u: string | URL, init?: RequestInit) => Promise<Response>;
  searxngUrl?: string;
  maxResults?: number;
}

// Query SearXNG and return formatted text. Fail-soft with actionable errors: a
// down service or a JSON-disabled instance point the operator at the fix rather
// than dumping a raw stack.
export async function performSearch(query: string, deps: SearchDeps = {}): Promise<string> {
  const base = (deps.searxngUrl || SEARXNG_URL).replace(/\/+$/, "");
  const target = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
  const doFetch = deps.fetch || fetch;
  const controller = new AbortController();
  // One timer over fetch + body read, same posture as httpGet.
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(target, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": UA },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`SearXNG returned HTTP ${res.status}. Is the searxng service running? (set SEARXNG_URL, or start the fleet's searxng container.)`);
    }
    const { text, truncated } = await readCapped(res, SEARCH_MAX_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`SearXNG did not return JSON${truncated ? " (response truncated)" : ""}. Enable the JSON format in settings.yml (search.formats: [html, json]).`);
    }
    return formatSearchResults(parsed, query, deps.maxResults ?? SEARCH_MAX_RESULTS);
  } catch (err) {
    const e = err as Error;
    throw new Error(e.name === "AbortError" || controller.signal.aborted ? `search timed out after ${FETCH_TIMEOUT_MS}ms` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

async function cmdSearch(query: string): Promise<void> {
  console.log(await performSearch(query));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , cmd, ...rest] = process.argv;
  const positionals: string[] = [];
  const flags: Record<string, string | undefined> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      flags[rest[i].slice(2)] = rest[i + 1];
      i++;
    } else {
      positionals.push(rest[i]);
    }
  }
  (async () => {
    try {
      if (cmd === "fetch") {
        if (!positionals[0]) throw new Error("usage: web-cli fetch <url> [--max-bytes N]");
        await cmdFetch(positionals[0], flags);
      } else if (cmd === "search") {
        const q = positionals.join(" ").trim();
        if (!q) throw new Error("usage: web-cli search <query>");
        await cmdSearch(q);
      } else {
        console.error("usage: web-cli fetch <url> [--max-bytes N] | web-cli search <query>");
        process.exit(1);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  })();
}
