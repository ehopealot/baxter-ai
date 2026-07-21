#!/usr/bin/env node
// skills-cli -- a READ-ONLY discovery gateway into the open agent-skills ecosystem
// (`npx skills` / skills.sh). Baxter uses it to FIND skills and suggest them to the
// operator; installing stays a human, host-side action. Design + threat model:
// docs/superpowers/specs/2026-07-21-skills-cli-discovery-design.md.
//
// The single verb is `find` -- there is deliberately NO add/install verb, so a
// prompt-injected run cannot install a skill through this CLI. Every field the
// operator or Baxter acts on (url, installCommand) is composed here from a strict,
// validated parse of the attacker-influenced registry response -- never naive
// string interpolation -- so a hostile `source`/`id` can't inject a shell command,
// a flag-shaped argument, or a path-escape into a pasted `npx skills add ...`.
// Responses are untrusted (treat like web-cli), capped, time-boxed, metadata-only.
import { pathToFileURL } from "node:url";

// Operator-only registry base override, validated like GMAIL_OAUTH_REDIRECT_BASE
// (the run can't set it: env-prefix doesn't match the Bash(skills-cli *) grant under
// the claude harness, and run_cli is a shell-less execFile allowlist otherwise).
export function validateRegistryBase(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { u = null; }
  if (!u || !/^https?:$/.test(u.protocol) || u.pathname !== "/" || /[?#]/.test(String(raw)) || u.username || u.password) {
    throw new Error(`SKILLS_REGISTRY_BASE must be scheme://host[:port] (http/https, no path/query/userinfo) -- got ${JSON.stringify(String(raw))}`);
  }
  return u.origin; // built from the parsed origin, not the raw string
}

export const REGISTRY_BASE = process.env.SKILLS_REGISTRY_BASE
  ? validateRegistryBase(process.env.SKILLS_REGISTRY_BASE)
  : "https://skills.sh";

const SEARCH_PATH = "/api/search";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MAX_QUERY = 512;
const MAX_RESULTS = 25;
const OUTPUT_MAX = 1_000_000; // ~1 MB cap on the response body
const REQUEST_TIMEOUT_MS = 15_000;

// A GitHub owner: alphanumerics + internal hyphens, start AND end alphanumeric
// (so a leading/trailing '-' or a flag-shaped '--registry' is rejected), <=39,
// no '.'/'_' (GitHub owners can't contain them).
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// repo + slug: alphanumeric first char (kills a leading '-' AND every dot-only
// segment like '.'/'..'), then [A-Za-z0-9._-], <=64.
const SEG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Verified vendor orgs only. `anthropic` (singular) is deliberately excluded --
// Anthropic's org is `anthropics`; a squatter on the singular would otherwise
// invert the strong trust signal.
const BUILTIN_TRUSTED = ["vercel-labs", "vercel", "anthropics", "microsoft"];

// Exact case-insensitive ASCII match against the allowlist (built-ins + any
// operator-added SKILLS_TRUSTED_OWNERS, each validated the SAME way, so a homoglyph
// or junk env entry can't sneak into the strong signal). GitHub owners are
// case-insensitive; validation-before-compare means the value is proven ASCII, so
// lowercasing is locale-stable (no Turkish-i / Kelvin case-fold trick).
export function isTrustedOwner(owner) {
  if (typeof owner !== "string" || !OWNER_RE.test(owner)) return false;
  const extra = (process.env.SKILLS_TRUSTED_OWNERS || "")
    .split(",").map((s) => s.trim()).filter((s) => OWNER_RE.test(s)).map((s) => s.toLowerCase());
  const lc = owner.toLowerCase();
  return BUILTIN_TRUSTED.includes(lc) || extra.includes(lc);
}

// Build the host-locked search URL. The path is a fixed literal and the run supplies
// only query VALUES (q, owner, limit) via URLSearchParams -- there's no path-suffix
// surface. assertConfined is belt-and-suspenders.
export function buildSearchUrl({ query, owner, limit } = {}) {
  if (typeof query !== "string" || query.length === 0) throw new Error("query is required");
  if (query.length > MAX_QUERY) throw new Error(`query too long (max ${MAX_QUERY} chars)`);
  if ([...query].some((ch) => { const c = ch.codePointAt(0); return c < 0x20 || c === 0x7f; })) {
    throw new Error("query contains a control character");
  }
  let lim = DEFAULT_LIMIT;
  if (limit !== undefined && limit !== null && limit !== "") {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--limit must be a positive integer (got ${JSON.stringify(limit)})`);
    lim = Math.min(n, MAX_LIMIT);
  }
  const url = new URL(SEARCH_PATH, REGISTRY_BASE); // fixed literal path, not run-supplied
  const params = new URLSearchParams({ q: query, limit: String(lim) });
  if (owner !== undefined && owner !== null && String(owner).length) params.set("owner", String(owner));
  url.search = params.toString();
  assertConfined(url, REGISTRY_BASE);
  return url;
}

// Authoritative confinement check: origin must equal the registry base and the path
// must be exactly the search path.
export function assertConfined(url, base) {
  const b = new URL(base);
  if (url.origin !== b.origin) throw new Error(`refusing request: ${url.origin} escaped registry base ${b.origin}`);
  if (url.pathname !== SEARCH_PATH) throw new Error(`refusing request: path ${url.pathname} is not ${SEARCH_PATH}`);
}

// Shape raw registry hits {id,name,installs,source} into validated rows. owner/repo/
// slug/url/installCommand are set ONLY when their strict validators pass; otherwise
// null + a labeled `sourceRaw`. Trusted-owner rows first (installs is a returned
// field but NOT the sort key -- it's self-reported, gameable telemetry).
export function formatResults(json) {
  // Real skills.sh shape is { query, searchType, skills: [...] }; each hit is
  // { id, skillId, name, installs, source } where `id` is the full "source/skillId"
  // path and `skillId` is the clean slug. (Accept a bare array / `results` too, for
  // robustness + unit tests.)
  const arr = Array.isArray(json) ? json
    : Array.isArray(json?.skills) ? json.skills
    : Array.isArray(json?.results) ? json.results
    : [];
  const rows = arr.slice(0, MAX_RESULTS).map((h) => {
    const source = typeof h?.source === "string" ? h.source : "";
    const skillId = typeof h?.skillId === "string" ? h.skillId : ""; // the clean slug (NOT `id`, which is the full path)
    const parts = source.split("/");
    const okSource = parts.length === 2 && OWNER_RE.test(parts[0]) && SEG_RE.test(parts[1]);
    const owner = okSource ? parts[0] : null;
    const repo = okSource ? parts[1] : null;
    const slug = SEG_RE.test(skillId) ? skillId : null;
    const url = owner && repo ? `https://github.com/${owner}/${repo}` : null;
    const installCommand = owner && repo && slug ? `npx skills add ${owner}/${repo}@${slug}` : null;
    const row = {
      slug,
      name: typeof h?.name === "string" ? h.name : "",
      installs: Number.isFinite(h?.installs) ? h.installs : 0,
      owner, repo, url, installCommand,
      trusted: owner ? isTrustedOwner(owner) : false,
    };
    if (!owner || !repo) row.sourceRaw = source; // unverified -- surfaced, labeled
    return row;
  });
  // Node's Array.sort is stable, so trusted-first preserves registry order within a tier.
  return rows.sort((a, b) => Number(b.trusted) - Number(a.trusted));
}

// The CLI's actual stdout serialization -- JSON so a hostile `name` (newlines/quotes)
// is escaped and can't forge a sibling field in the run's context.
export function renderResults(rows) {
  return JSON.stringify(rows, null, 2);
}

// Cap the body while READING it (mirrors web-cli/data-cli readCapped) -- streams and
// cancels the reader once hardMax bytes arrive, so a hostile/misbehaving registry
// can't buffer hundreds of MB before the cap fires. Reader-less responses (test
// stubs) fall back to arrayBuffer() or text(), whichever the body exposes.
async function readCapped(res, hardMax) {
  const reader = res.body?.getReader?.();
  if (reader) {
    const chunks = [];
    let total = 0, truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      chunks.push(Buffer.from(value));
      if (total >= hardMax) { truncated = true; try { await reader.cancel(); } catch { /* ignore */ } break; }
    }
    return { text: Buffer.concat(chunks).subarray(0, hardMax).toString("utf8"), truncated };
  }
  const raw = typeof res.arrayBuffer === "function"
    ? Buffer.from(await res.arrayBuffer())
    : Buffer.from(String(await res.text()), "utf8");
  return { text: raw.subarray(0, hardMax).toString("utf8"), truncated: raw.length > hardMax };
}

// Injectable `deps.fetch` for tests. GET only; a non-2xx / non-JSON / timeout /
// network error yields a clean { ok:false, error } result, never a throw. Body
// capped-while-read + flagged.
export async function performSearch(url, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchFn(String(url), { method: "GET", signal: ctrl.signal, redirect: "manual" });
    const status = res.status ?? (res.ok ? 200 : 0);
    const { text, truncated } = await readCapped(res, OUTPUT_MAX);
    if (!res.ok) return { ok: false, status, error: `registry returned status ${status}`, truncated };
    let parsed;
    try { parsed = JSON.parse(text); } catch { return { ok: false, status, error: "non-JSON response from registry", truncated }; }
    return { ok: true, status, results: formatResults(parsed), truncated };
  } catch (e) {
    if (e?.name === "AbortError" || ctrl.signal.aborted) return { ok: false, status: 0, error: `request timed out after ${REQUEST_TIMEOUT_MS}ms` };
    return { ok: false, status: 0, error: `request failed: ${e?.message ?? e}` };
  } finally {
    clearTimeout(timer);
  }
}

const USAGE = "usage: skills-cli find <query> [--owner <owner>] [--limit <n>]";
const ALLOWED_FLAGS = new Set(["owner", "limit"]);

// `find` is the only verb. Unknown verb / unknown flag / a flag with no value all
// error loudly (a stray flag can't swallow a value; a future --base can't sneak in).
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "find") throw new Error(`unknown command ${JSON.stringify(command)} -- only \`find\` is supported. ${USAGE}`);
  const positionals = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!ALLOWED_FLAGS.has(name)) throw new Error(`unknown flag --${name}. ${USAGE}`);
      const val = rest[++i];
      if (val === undefined) throw new Error(`--${name} needs a value. ${USAGE}`);
      flags[name] = val;
    } else {
      positionals.push(a);
    }
  }
  return { command, positionals, flags };
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const query = positionals.join(" ").trim();
  if (!query) { console.error(USAGE); process.exit(1); }
  const url = buildSearchUrl({ query, owner: flags.owner, limit: flags.limit });
  const r = await performSearch(url);
  if (!r.ok) { console.error(`skills-cli: ${r.error}`); process.exit(1); }
  console.log(renderResults(r.results));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => { console.error(`skills-cli: ${e.message}`); process.exit(1); });
}
