#!/usr/bin/env node
// web-cli: credential-less web access for the agent run -- `fetch <url>` (HTTP GET
// + HTML->text) and `search <query>` (DuckDuckGo's keyless HTML endpoint). Reaches
// the net from the daemon container; holds no secret and writes nothing. When a
// page is JS-heavy or DDG blocks / returns nothing, the run falls back to
// playwright-cli/invisible-cli (see skills/web). Raw fetch, no deps. The pure
// helpers are exported for tests; the CLI dispatch at the bottom is guarded so
// importing this file (e.g. from a test) doesn't execute it.
import { pathToFileURL } from "node:url";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DEFAULT_MAX_BYTES = 200 * 1024;
const SEARCH_READ_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 20000;

// --- pure helpers (exported for tests) ---

// Refuse non-http(s) schemes and obvious internal targets. NOT full SSRF
// protection -- a hostname that RESOLVES to a private IP still passes -- which is
// the same accepted residual as the browser CLIs (see app/CLAUDE.md's note on
// internal reachability). Returns the parsed URL or throws.
export function guardUrl(raw) {
  let u;
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
    host === "0.0.0.0" ||
    host.startsWith("::ffff:") || // IPv4-mapped IPv6 (::ffff:127.0.0.1 routes to 127.0.0.1) -- refuse wholesale
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^0\./.test(host) || // 0.0.0.0/8, incl. the bare "0" the URL parser normalizes to 0.0.0.0
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    // IPv6 ULA (fc00::/7) + link-local (fe80::/10) -- only for IPv6 literals (they
    // contain ":"), so a normal domain like "fc-barcelona.com" isn't caught.
    (host.includes(":") && (/^f[cd]/i.test(host) || /^fe[89ab]/i.test(host)));
  if (internal) throw new Error(`refusing to fetch an internal/loopback host: ${host}`);
  return u;
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (Object.hasOwn(NAMED_ENTITIES, e)) return NAMED_ENTITIES[e];
    let code;
    if (/^#x/i.test(e)) code = parseInt(e.slice(2), 16);
    else if (/^#/.test(e)) code = parseInt(e.slice(1), 10);
    if (Number.isFinite(code)) {
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
export function htmlToText(html) {
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

export function extractTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

// DDG's html endpoint wraps result links as `/l/?uddg=<url-encoded real url>`.
// Decode to the real destination; pass through a bare http(s) href unchanged.
export function ddgRealUrl(href) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    // searchParams.get already percent-decodes once, yielding the exact real
    // URL -- decoding again would corrupt legit escapes in it (C%2B%2B -> C++).
    const uddg = u.searchParams.get("uddg");
    if (uddg) return uddg;
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    /* fall through */
  }
  return href;
}

// Parse DDG's HTML results page into [{ title, url, snippet }] (top `limit`).
// Anchor with class result__a carries the title + wrapped href; the following
// result__snippet carries the snippet. Tolerant of minor markup drift.
export function parseDdgResults(html, limit = 8) {
  const out = [];
  const re = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const url = ddgRealUrl(decodeEntities(m[1]));
    const title = htmlToText(m[2]).replace(/\s+/g, " ").trim();
    // Bound the snippet search at the NEXT result anchor so a snippet-less result
    // doesn't steal the following result's snippet.
    const nextAnchor = html.indexOf("result__a", re.lastIndex);
    const end = nextAnchor === -1 ? m.index + 3000 : Math.min(nextAnchor, m.index + 3000);
    const after = html.slice(re.lastIndex, end);
    const sm = after.match(/class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = sm ? htmlToText(sm[1]).replace(/\s+/g, " ").trim() : "";
    if (url && title) out.push({ title, url, snippet });
  }
  return out;
}

// --- network + CLI (not exported) ---

// Read a response body but never buffer more than hardMax bytes (a huge page
// can't OOM the daemon). Returns { text, truncated }.
async function readCapped(res, hardMax) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { text: buf.subarray(0, hardMax).toString("utf8"), truncated: buf.length > hardMax };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(Buffer.from(value));
    if (total >= hardMax) {
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
  }
  return { text: Buffer.concat(chunks).subarray(0, hardMax).toString("utf8"), truncated };
}

async function httpGet(url, hardMax) {
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
    throw new Error(err.name === "AbortError" || controller.signal.aborted ? `request timed out after ${FETCH_TIMEOUT_MS}ms` : err.message);
  } finally {
    clearTimeout(timer);
  }
}

async function cmdFetch(url, flags) {
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

async function cmdSearch(query, flags) {
  const n = Number(flags.n) > 0 ? Number(flags.n) : 8;
  const r = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, SEARCH_READ_BYTES);
  const results = parseDdgResults(r.text, n);
  if (!results.length) {
    console.log(
      "No results -- DuckDuckGo may be rate-limiting or blocking this request. Try again, refine the query, or use playwright-cli/invisible-cli to search interactively.",
    );
    return;
  }
  console.log(results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}${x.snippet ? `\n   ${x.snippet}` : ""}`).join("\n\n"));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , cmd, ...rest] = process.argv;
  const positionals = [];
  const flags = {};
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
        if (!q) throw new Error("usage: web-cli search <query> [--n N]");
        await cmdSearch(q, flags);
      } else {
        console.error("usage: web-cli <fetch <url> [--max-bytes N] | search <query> [--n N]>");
        process.exit(1);
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  })();
}
