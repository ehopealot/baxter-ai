// The curated data-source registry for data-cli -- config-as-code. Each entry is
// a small, plain object; adding a source is one entry here (plus, for a keyed
// source, one line in the secrets file). No new binary, grant, skill, or shim.
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
//   hint      one-liner: what this source is the preferred pick for (surfaced by `list`)
//   describe  multi-line human blurb: base, endpoint patterns, worked examples (surfaced by `describe`)
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
    describe: [
      "ESPN's unofficial site API. Path shape: {sport}/{league}/{endpoint}.",
      "Common endpoints:",
      "  {sport}/{league}/scoreboard        today's games + live/final scores",
      "  {sport}/{league}/teams             all teams in a league",
      "  {sport}/{league}/teams/{id}        one team",
      "Leagues: football/nfl, football/college-football, basketball/nba,",
      "  basketball/mens-college-basketball, baseball/mlb, hockey/nhl, soccer/{league}.",
      "Add --query dates=YYYYMMDD to scoreboard for a specific day.",
      "Examples:",
      "  data-cli espn basketball/nba/scoreboard",
      "  data-cli espn football/nfl/scoreboard --query dates=20260215",
      "  data-cli espn baseball/mlb/teams",
      "Undocumented/unofficial -- if a path 404s the shape may have changed; a fix is one registry edit.",
    ].join("\n"),
  },

  nominatim: {
    name: "nominatim",
    base: "https://nominatim.openstreetmap.org",
    auth: null,
    // Nominatim's usage policy REQUIRES a descriptive identifying User-Agent;
    // the CLI always sends this so the model never has to (and can't drop it).
    headers: { "User-Agent": "BaxterBurgundy/1.0 (self-hosted personal assistant)" },
    hint: "geocoding + place lookup (address <-> coordinates), via OpenStreetMap",
    describe: [
      "OpenStreetMap's Nominatim geocoder. Always pass --query format=json.",
      "Endpoints:",
      "  search    free-text -> places.   --query q=\"<text>\" --query format=json [--query limit=N]",
      "  reverse   coords -> address.      --query lat=<n> --query lon=<n> --query format=json",
      "Examples:",
      "  data-cli nominatim search --query q=\"Powell's Books, Portland\" --query format=json",
      "  data-cli nominatim reverse --query lat=45.523 --query lon=-122.681 --query format=json",
      "Courtesy limit ~1 request/second (no code enforcement -- just don't hammer it).",
    ].join("\n"),
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
