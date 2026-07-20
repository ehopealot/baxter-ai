// The curated data-source registry for data-cli -- config-as-code. Each entry is
// a small, plain object; adding a source is one entry here (plus, for a keyed
// source, one line in the secrets file). No new binary, grant, skill, or shim.
//
// The registry owns ONLY the trust-critical + editorial bits: the fixed host,
// the auth/key, any required static headers, and a one-line routing hint. It does
// NOT bake each source's endpoint SHAPE (which paths exist, params, examples) --
// that's knowledge that rots and is exactly what Baxter can re-derive, so it
// lives in a per-source LEARNED skill (`data-cli-<name>`) he researches, verifies
// live, and maintains. `data-cli describe <source>` points him at that skill (and
// bootstraps writing one if it's missing). See data-cli.mjs renderDescribe.
//
// The SECURITY-LOAD-BEARING field is `base`: scheme + host + root path, fully
// owned by us. The model supplies only the path suffix + query params, and
// data-cli asserts the resolved URL never escapes this base host (see
// data-cli.mjs buildUrl). So a keyed source's key can only ever reach that host.
//
// Fields:
//   name      canonical source name (the first CLI arg)
//   base      fixed scheme+host+root path -- NO trailing slash (data-cli joins with "/")
//   auth      null (keyless), or:
//               { type: "query",  param: "token",     keyName: "FOO_KEY" }  -> ?token=<key>
//               { type: "header", name:  "X-Api-Key", keyName: "FOO_KEY" }  -> header
//             keyName indexes into ~/.mail-agent/data-keys.json (DATA_KEYS_PATH).
//   headers   optional static headers the CLI always sends (e.g. a required User-Agent)
//   hint      one-liner: what this source is the preferred pick for (surfaced by `list`/`describe`)
//   note      optional editorial USAGE-POLICY constraint surfaced by `describe` (e.g. a
//             courtesy rate limit) -- kept here because it's policy, not endpoint shape
//   cap       optional per-source response byte cap (defaults to DEFAULT_MAX_BYTES)
//
// Both seed sources are keyless, so v1 needs no sign-up. The key-injection path
// is built and tested against a fake keyed source (see the test file) so the
// first real keyed source is pure config.

export const SOURCES = {
  espn: {
    name: "espn",
    base: "https://site.api.espn.com/apis/site/v2/sports",
    auth: null,
    hint: "scores, schedules, standings for major US leagues (NFL, NBA, MLB, NHL, college)",
  },

  nominatim: {
    name: "nominatim",
    base: "https://nominatim.openstreetmap.org",
    auth: null,
    // Nominatim's usage policy REQUIRES a descriptive identifying User-Agent;
    // the CLI always sends this so the model never has to (and can't drop it).
    headers: { "User-Agent": "BaxterBurgundy/1.0 (self-hosted personal assistant)" },
    hint: "geocoding + place lookup (address <-> coordinates), via OpenStreetMap",
    note: "courtesy limit ~1 request/second (not code-enforced) -- pause between probes, don't hammer it",
  },
};

// type -> preferred source routing hints, surfaced by `data-cli list`. This is
// where the "preferred source per query type" goal lives -- as guidance, not a
// rigid intent enum. Freeform to add to; not exhaustive.
export const ROUTING = [
  ["sports scores / schedules / standings", "espn"],
  ["geocoding / places / addresses", "nominatim"],
  // finance/stocks -> back-burnered (no keyed source onboarded in v1)
];
