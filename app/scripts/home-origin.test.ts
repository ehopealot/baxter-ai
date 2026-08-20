// Tests for home-origin: the shared, env-injectable HOME_BASE_URL validator extracted
// verbatim from link-cli's private baseUrl() (same rules, same byte-exact error
// message) so link-cli, the feature-discovery prompt note, and delivered-link matching
// agree on what a Home origin is. Pure unit tests (no process spawn, no fs): every
// case passes an explicit env object; both exported variants must agree because they
// share one internal validate routine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HOME_ORIGIN, homeOriginOrThrow, validatedHomeOrigin } from "./home-origin.ts";

function env(v?: string): NodeJS.ProcessEnv {
  return v === undefined ? {} : { HOME_BASE_URL: v };
}

// The null-returning and the throwing variant sit on ONE validator: every invalid
// input must produce null from the former AND a throw from the latter -- they can
// never disagree about what is valid.
function assertRejected(v: string): void {
  assert.equal(validatedHomeOrigin(env(v)), null, `validatedHomeOrigin should reject ${JSON.stringify(v)}`);
  assert.throws(() => homeOriginOrThrow(env(v)), { message: `HOME_BASE_URL must be a bare http(s) origin (scheme://host[:port], no path/query/userinfo): ${JSON.stringify(v.replace(/\/+$/, ""))}` });
}

// ---- default origin ----
test("HOME_BASE_URL unset or empty means the default origin (empty-means-unset, || semantics)", () => {
  assert.equal(DEFAULT_HOME_ORIGIN, "https://home.bax.bot");
  assert.equal(validatedHomeOrigin(env()), DEFAULT_HOME_ORIGIN);
  assert.equal(validatedHomeOrigin(env("")), DEFAULT_HOME_ORIGIN);
  assert.equal(homeOriginOrThrow(env()), DEFAULT_HOME_ORIGIN);
  assert.equal(homeOriginOrThrow(env("")), DEFAULT_HOME_ORIGIN);
});

test("the no-argument form reads process.env (env-injectable default parameter)", () => {
  const prev = process.env.HOME_BASE_URL;
  try {
    delete process.env.HOME_BASE_URL;
    assert.equal(validatedHomeOrigin(), DEFAULT_HOME_ORIGIN);
    assert.equal(homeOriginOrThrow(), DEFAULT_HOME_ORIGIN);
    process.env.HOME_BASE_URL = "https://env.example.com";
    assert.equal(validatedHomeOrigin(), "https://env.example.com");
    assert.equal(homeOriginOrThrow(), "https://env.example.com");
  } finally {
    if (prev === undefined) delete process.env.HOME_BASE_URL;
    else process.env.HOME_BASE_URL = prev;
  }
});

// ---- accepted overrides ----
test("trailing slashes are trimmed before parsing (https://x.example.com/ -> https://x.example.com)", () => {
  assert.equal(validatedHomeOrigin(env("https://x.example.com/")), "https://x.example.com");
  assert.equal(homeOriginOrThrow(env("https://x.example.com/")), "https://x.example.com");
  assert.equal(homeOriginOrThrow(env("https://x.example.com///")), "https://x.example.com"); // ALL trailing slashes
});

test("host case and default ports normalize via the parsed origin (https://HOME.example.com:443 -> https://home.example.com)", () => {
  assert.equal(validatedHomeOrigin(env("https://HOME.example.com:443")), "https://home.example.com");
  assert.equal(homeOriginOrThrow(env("https://HOME.example.com:443")), "https://home.example.com");
  assert.equal(homeOriginOrThrow(env("http://x.example.com:80")), "http://x.example.com"); // http's default port too
});

// ---- rejections (null + throw variants share one validator) ----
test("a value carrying a path/query/fragment/userinfo is rejected by both variants", () => {
  for (const bad of [
    "https://x.example.com/prefix",
    "https://x.example.com/prefix/",
    "https://x.example.com?x=1",
    "https://x.example.com/#frag",
    "https://user:pass@x.example.com",
    "https://user@x.example.com",
  ]) {
    assertRejected(bad);
  }
});

test("a non-http(s) scheme, and an unparseable value, are rejected by both variants", () => {
  for (const bad of ["ftp://files.example.com", "file:///tmp", "example.com"]) {
    assertRejected(bad);
  }
});

// ---- exact-message pin (byte-for-byte link-cli.ts:38-45) ----
test("EXACT-MESSAGE PIN: a set-but-invalid value throws link-cli's byte-exact message, naming the POST-trailing-slash-trim raw", () => {
  assert.throws(
    () => homeOriginOrThrow(env("https://x.example.com/prefix/")),
    (err: unknown) =>
      err instanceof Error &&
      err.message === 'HOME_BASE_URL must be a bare http(s) origin (scheme://host[:port], no path/query/userinfo): "https://x.example.com/prefix"',
  );
});
