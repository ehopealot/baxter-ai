#!/usr/bin/env node
// data-cli: a curated read-only gateway to a handful of preferred data sources
// (scores, geocoding, ... -- see data-sources.mjs). Baxter supplies a SOURCE +
// path + query params; the CLI owns the host and the auth. Reaches the net from
// the daemon container. No deps, no shell.
//
//   data-cli <source> <path> [--query k=v ...]
//   data-cli list                 sources + "preferred source for X" routing hints
//   data-cli describe <source>    base host, key status, + pointer to the per-source skill (data-cli-<source>)
//
// SECURITY (see the spec docs/superpowers/specs/2026-07-19-data-cli-design.md):
//   * Host is fixed per source (registry `base`); the model controls only the
//     path suffix + query values, never the host. A keyed source's key can only
//     ever be sent to that source's real host.
//   * buildUrl uses STRING CONCAT (never the two-arg `new URL(path, base)`
//     resolution form, which would resolve a leading `/` or `//host` against the
//     base and escape it) and then ASSERTS origin + path-prefix on the resolved
//     URL -- that assert is the load-bearing check; the reject-list is fast-fail
//     hygiene.
//   * Keyed sources use redirect:"manual" -- a 3xx is NOT followed (an open
//     redirect would carry a query-param token cross-origin). Keyless sources may
//     follow, but the final origin is re-asserted.
//   * Keys come from DATA_KEYS_PATH (0600, outside MEMORY_DIR) at runtime; the
//     run's env holds none. The key value is scrubbed out of all emitted output
//     so it can't leak via an API that echoes the request URL in an error body.
//   * Responses are untrusted (treat like web-cli/WebFetch content), capped, and
//     time-boxed by a single AbortController covering fetch + body read.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SOURCES, ROUTING } from "./data-sources.mjs";
import { DATA_KEYS_PATH, LEARNED_SKILLS_DIR } from "./paths.mjs";

// Each source's endpoint SHAPE (paths, params, examples) is not baked here -- it
// lives in a per-source LEARNED skill Baxter researches + maintains, named by this
// convention. The registry owns only the trust-critical bits (host, auth, key) +
// a routing hint; `describe` points at the skill (and bootstraps writing one).
const sourceSkillName = (name) => `data-cli-${name}`;

const DEFAULT_MAX_BYTES = 200 * 1024;
const FETCH_TIMEOUT_MS = 20000;
const DEFAULT_UA = "BaxterBurgundy/1.0 (self-hosted personal assistant)";

// --- pure helpers (exported for tests) ---

// Look up a source by name or throw a listing-pointing error.
export function getSource(name) {
  const src = Object.hasOwn(SOURCES, String(name)) ? SOURCES[name] : null;
  if (!src) {
    throw new Error(`unknown source "${name}" -- run \`data-cli list\` to see the available sources`);
  }
  return src;
}

// Build the final URL for a request, confined to the source's fixed base host.
// rawPath is the model-supplied positional path; queryPairs is [[k,v],...]
// (user --query params plus, for a query-auth source, the injected key param).
//
// Two layers, per the spec:
//   (1) reject-list -- fast-fail hygiene on the RAW path before it's parsed.
//   (2) resolved-URL assert -- the authoritative check: after string-concat +
//       new URL(), the origin must equal the base origin and the pathname must
//       be the base path or a child of it (trailing-slash guard stops a sibling
//       like `.../sportsfoo` slipping past `.../sports`).
export function buildUrl(source, rawPath, queryPairs = []) {
  const raw = String(rawPath ?? "");
  // (1) reject-list on the raw path.
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error("path contains a control character");
  if (raw.includes("\\")) throw new Error("path may not contain a backslash");
  // ? # % are barred: query/fragment must come through --query, and % blocks
  // percent-encoded traversal (%2e%2e) that new URL() would normalize to real
  // dot-dot and slip past the literal `..` check below.
  if (/[?#%]/.test(raw)) throw new Error("path may not contain '?', '#' or '%' -- use --query for query params");
  if (/:\/\//.test(raw) || raw.startsWith("//")) throw new Error("path may not contain a scheme or host");
  if (raw.startsWith("/")) throw new Error("path must be relative to the source base (no leading '/')");
  if (/(^|\/)\.\.(\/|$)/.test(raw)) throw new Error("path may not contain '..'");

  const base = String(source.base).replace(/\/+$/, ""); // registry base, trailing slash stripped
  const cleanPath = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  // (2) STRING CONCAT -- never new URL(path, base).
  const url = new URL(base + "/" + cleanPath);
  for (const [k, v] of queryPairs) url.searchParams.append(String(k), String(v));
  return assertConfined(url, base);
}

// The authoritative, load-bearing confinement check: the resolved URL's origin
// must equal the base's, and its pathname must be the base path OR a child of it
// (the trailing-slash guard stops a sibling like `.../sportsfoo` slipping past
// `.../sports`). Exported so it can be tested directly against hand-built sibling
// / off-host URLs -- the reject-list makes such a URL unreachable through
// buildUrl, so this is the only way to exercise the reject branches.
export function assertConfined(url, base) {
  const baseUrl = new URL(base);
  const basePath = baseUrl.pathname.replace(/\/+$/, ""); // "" for a host-root base
  if (url.origin !== baseUrl.origin) {
    throw new Error(`refusing request: resolved host ${url.origin} escaped source base ${baseUrl.origin}`);
  }
  if (!(url.pathname === basePath || url.pathname.startsWith(basePath + "/"))) {
    throw new Error(`refusing request: resolved path ${url.pathname} escaped source base ${basePath || "/"}`);
  }
  return url;
}

// Resolve a source's auth into an injectable form using the loaded key map.
// Returns { queryParam: [name,val]|null, header: [name,val]|null, keyValue:
// string|null }. Keyless -> all null. Missing key -> throws (no request made).
export function resolveAuth(source, keys) {
  const auth = source.auth;
  if (!auth) return { queryParam: null, header: null, keyValue: null };
  const keyValue = keys && Object.hasOwn(keys, auth.keyName) ? keys[auth.keyName] : null;
  if (!keyValue) {
    throw new Error(`source "${source.name}" needs key "${auth.keyName}" but it's not in ${DATA_KEYS_PATH}`);
  }
  if (auth.type === "query") return { queryParam: [auth.param, keyValue], header: null, keyValue };
  if (auth.type === "header") return { queryParam: null, header: [auth.name, keyValue], keyValue };
  throw new Error(`source "${source.name}" has an unknown auth type "${auth.type}"`);
}

// Redact every secret value from text before it's emitted, so a key echoed back
// in an API error body / request URL never reaches the run's context. secrets is
// a list of literal key strings; empty/falsy values are ignored.
export function scrub(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) {
    if (s) out = out.split(s).join("[key]");
  }
  return out;
}

// Read + parse the keys file. Missing file -> {} (only an error if a keyed
// source actually needs a key -- resolveAuth throws then). A malformed file is a
// real, surfaced error.
export function loadKeys(path = DATA_KEYS_PATH) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`data-keys file at ${path} is not valid JSON`);
  }
}

// --- network + rendering (not exported; fetch injectable for tests) ---

// Read a response body but never buffer more than hardMax bytes. Mirrors
// web-cli's readCapped. Returns { text, truncated }.
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
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  return { text: Buffer.concat(chunks).subarray(0, hardMax).toString("utf8"), truncated };
}

// Perform the request under the host lock. `auth` is resolveAuth's result;
// `deps.fetch` lets tests inject a stub. Returns { status, finalUrl, text,
// truncated } with the key already scrubbed out of text and finalUrl.
export async function performRequest(source, url, auth, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const hardMax = Number(source.cap) > 0 ? Number(source.cap) : DEFAULT_MAX_BYTES;
  const keyed = !!(auth && auth.keyValue);
  // Scrub the RAW key AND its URL-encoded forms: a query-param key is
  // percent-encoded in the request URL (URLSearchParams turns `+`->`%2B`,
  // `/`->`%2F`, `=`->`%3D`, space->`+`), so a literal-only scrub would miss the
  // exact form that appears in the URL an API echoes back. Cover both encoders.
  const secrets = keyed
    ? [...new Set([
        auth.keyValue,
        encodeURIComponent(auth.keyValue),
        new URLSearchParams([["k", auth.keyValue]]).toString().slice(2), // space->`+` variant
      ])]
    : [];

  const headers = { "User-Agent": DEFAULT_UA, Accept: "application/json,text/plain,*/*", ...(source.headers || {}) };
  if (auth && auth.header) headers[auth.header[0]] = auth.header[1];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      // Keyed: never follow a redirect -- an open redirect would carry a
      // query-param token cross-origin. Keyless: follow, but re-assert origin.
      redirect: keyed ? "manual" : "follow",
      signal: controller.signal,
      headers,
    });

    if (keyed && res.type === "opaqueredirect") {
      throw new Error(`source "${source.name}" returned a redirect; not following it to protect the API key`);
    }
    if (!keyed) {
      const finalOrigin = new URL(res.url || url.toString()).origin;
      if (finalOrigin !== new URL(source.base).origin) {
        throw new Error(`refusing to follow a redirect off the source host to ${finalOrigin}`);
      }
    }

    const { text, truncated } = await readCapped(res, hardMax);
    // Report a key-free URL: structurally replace the auth query param with
    // [key] (robust regardless of the key's encoding), then scrub the raw +
    // encoded key from both the URL and the body as a second belt.
    let safeUrl = url.toString();
    if (auth && auth.queryParam) {
      const u = new URL(url);
      u.searchParams.set(auth.queryParam[0], "[key]");
      safeUrl = u.toString();
    }
    return { status: res.status, finalUrl: scrub(safeUrl, secrets), text: scrub(text, secrets), truncated, hardMax };
  } catch (err) {
    if (err.name === "AbortError" || controller.signal.aborted) {
      throw new Error(`request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw new Error(scrub(err.message, secrets)); // never leak the key via an error string
  } finally {
    clearTimeout(timer);
  }
}

function renderList() {
  const lines = ["Curated data sources (data-cli <source> <path> [--query k=v ...]):", ""];
  for (const src of Object.values(SOURCES)) {
    lines.push(`  ${src.name}  —  ${src.hint}${src.auth ? "  [needs key]" : ""}`);
  }
  lines.push("", "Preferred source by query type:");
  for (const [type, name] of ROUTING) lines.push(`  ${type}  →  ${name}`);
  lines.push("", "`data-cli describe <source>` points you at that source's skill (or bootstraps writing one).");
  return lines.join("\n");
}

// describe is a POINTER, not an API manual: it tells Baxter the trust-critical
// facts (base host, whether a key is handled for him) and routes him to the
// per-source learned skill that holds the actual endpoint shape -- or, if he
// hasn't written that skill yet, tells him to research the API and write it.
export function renderDescribe(source) {
  const skill = sourceSkillName(source.name);
  const authDesc = !source.auth
    ? "keyless (no key needed)"
    : `${source.auth.type} auth — the CLI adds the "${source.auth.keyName}" key for you; you never see or handle it`;
  return [
    `${source.name}  —  ${source.hint}`,
    `base: ${source.base}`,
    `auth: ${authDesc}`,
    ...(source.note ? [`note: ${source.note}`] : []),
    ``,
    `Endpoint shape (paths + query params): open your \`${skill}\` skill with the Skill tool — that's where you keep what actually works for this source.`,
    `No \`${skill}\` skill yet? Then work out the shape now: probe from the base (a trial \`data-cli ${source.name} <path>\` call and/or web research on the API), do the task, and WRITE \`${skill}\` as a learned skill at ${LEARNED_SKILLS_DIR}/${skill}/SKILL.md so a future run just opens it. Record only VERIFIED paths/params — the CLI still owns the host + any key, so a wrong path just fails, it can't leak anything.`,
  ].join("\n");
}

// --- arg parse + CLI dispatch ---

// Split argv into positionals, repeatable --query k=v pairs, and other --flags.
export function parseArgs(argv) {
  const positionals = [];
  const query = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--query") {
      const kv = argv[++i];
      if (kv == null) throw new Error("--query needs a k=v argument");
      const eq = kv.indexOf("=");
      if (eq < 1) throw new Error(`--query expects k=v (got "${kv}")`);
      query.push([kv.slice(0, eq), kv.slice(eq + 1)]);
    } else if (a.startsWith("--")) {
      flags[a.slice(2)] = argv[++i];
    } else {
      positionals.push(a);
    }
  }
  return { positionals, query, flags };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(renderList());
    return;
  }
  if (cmd === "list") {
    console.log(renderList());
    return;
  }
  if (cmd === "describe") {
    if (rest.length !== 1) throw new Error("usage: data-cli describe <source>");
    console.log(renderDescribe(getSource(rest[0])));
    return;
  }

  // Otherwise: cmd is a SOURCE name; rest is <path> + flags.
  const source = getSource(cmd);
  const { positionals, query, flags } = parseArgs(rest);
  // No non-query flag is implemented; reject an unknown one loudly rather than
  // silently swallowing it (and its value), matching the CLI's fail-fast posture.
  const unknown = Object.keys(flags);
  if (unknown.length) {
    throw new Error(`unknown flag --${unknown[0]} (only --query k=v is supported; put params after --query)`);
  }
  if (positionals.length !== 1) {
    throw new Error(`usage: data-cli ${source.name} <path> [--query k=v ...]  (see \`data-cli describe ${source.name}\`)`);
  }
  const auth = resolveAuth(source, source.auth ? loadKeys() : null);
  const queryPairs = auth.queryParam ? [...query, auth.queryParam] : query;
  const url = buildUrl(source, positionals[0], queryPairs);
  const r = await performRequest(source, url, auth);

  let out = `Source: ${source.name}\nURL: ${r.finalUrl}\nStatus: ${r.status}\n\n${r.text}`;
  if (r.truncated) out += `\n\n[truncated at ${r.hardMax} bytes -- narrow the query]`;
  console.log(out);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(`data-cli: ${err.message}`);
    process.exit(1);
  });
}
