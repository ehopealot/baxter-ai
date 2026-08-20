// home-origin: the ONE validated HOME_BASE_URL origin, shared by link-cli, the
// feature-discovery prompt note, and delivered-link matching. The rules and the error
// message are extracted verbatim from link-cli's private baseUrl() so every consumer
// agrees on what a Home origin is (link-cli migrates onto homeOriginOrThrow without
// any behavior change; the discovery path uses validatedHomeOrigin's fail-open null).
//
// Operator-only origin (the run's Bash(link-cli *) grant can't set env). Validated
// authoritatively via new URL() so a value carrying a path/query/fragment/userinfo
// is rejected rather than smuggled into a link -- matches data-cli/skills-cli's
// posture. Empty-means-unset (||, not ??): an env_file `HOME_BASE_URL=` is the empty
// string, not nullish, and new URL("") would throw -- so treat falsy as unset,
// like skills-cli. Returning u.origin (not the raw string) is what collapses host
// case and default ports (:80/:443).

export const DEFAULT_HOME_ORIGIN = "https://home.bax.bot";

const INVALID_MESSAGE = "HOME_BASE_URL must be a bare http(s) origin (scheme://host[:port], no path/query/userinfo):";

type HomeOriginValidation = { origin: string } | { message: string };

// One validate routine under both exported variants, so they can never disagree.
// Trailing slashes are trimmed BEFORE parsing and BEFORE the error message renders
// (a set-but-invalid "https://x.example.com/prefix/" errors naming the trimmed value).
function validateHomeOrigin(env: NodeJS.ProcessEnv): HomeOriginValidation {
  const raw = (env.HOME_BASE_URL || DEFAULT_HOME_ORIGIN).replace(/\/+$/, "");
  let u: URL;
  try { u = new URL(raw); } catch {
    return { message: `${INVALID_MESSAGE} ${JSON.stringify(raw)}` };
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
    return { message: `${INVALID_MESSAGE} ${JSON.stringify(raw)}` };
  }
  return { origin: u.origin };
}

// The canonical Home origin for this env, or null when HOME_BASE_URL is SET but
// invalid -- the fail-open form (an invalid override never blocks a reply).
export function validatedHomeOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = validateHomeOrigin(env);
  return "origin" in v ? v.origin : null;
}

// The throwing form for CLIs: link-cli's exact behavior, byte-identical message.
export function homeOriginOrThrow(env: NodeJS.ProcessEnv = process.env): string {
  const v = validateHomeOrigin(env);
  if (!("origin" in v)) throw new Error(v.message);
  return v.origin;
}
