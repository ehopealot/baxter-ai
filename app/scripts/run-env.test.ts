// TDD (red until implemented): the central run-env credential strip (spec
// Finding 2). runtime.ts's runAgent is the one spawn path all four daemons
// (poll/discord/heartbeat/voice) go through, so stripping the surface secrets
// there covers every run at once -- instead of each daemon remembering to.
// See docs/superpowers/specs/2026-07-22-agentmail-migration-design.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripRunSecrets, RUN_SECRET_ENV_VARS } from "./runtime.ts";

test("stripRunSecrets removes the surface credentials but keeps the model-provider keys", () => {
  const env = {
    RESEND_API_KEY: "re", // full authority via the mail CLI file-fallback -> must not reach a run's env
    RESEND_WEBHOOK_SECRET: "rws",
    DISCORD_BOT_TOKEN: "dt", // ditto via discord-cli's file fallback
    OPENROUTER_API_KEY: "or", // on the openrouter/local harness the runner IS the run -> needs this
    OPENAI_API_KEY: "oa",
    PATH: "/usr/bin",
    BAXTER_EXPECT_REPLY: "1",
  };
  const out = stripRunSecrets(env);
  assert.equal(out.RESEND_API_KEY, undefined);
  assert.equal(out.RESEND_WEBHOOK_SECRET, undefined);
  assert.equal(out.DISCORD_BOT_TOKEN, undefined);
  assert.equal(out.OPENROUTER_API_KEY, "or");
  assert.equal(out.OPENAI_API_KEY, "oa");
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.BAXTER_EXPECT_REPLY, "1");
});

test("stripRunSecrets removes keyed data-cli source keys (e.g. YOUTUBE_API_KEY) -- reached only via the 0600 keys file, never the run's env", () => {
  const env = { YOUTUBE_API_KEY: "AIzaSecret", PATH: "/usr/bin" };
  const out = stripRunSecrets(env);
  assert.equal(out.YOUTUBE_API_KEY, undefined);
  assert.equal(out.PATH, "/usr/bin");
});

test("stripRunSecrets does not mutate the caller's env (the daemon's own process.env stays intact)", () => {
  const env = { RESEND_API_KEY: "re", RESEND_WEBHOOK_SECRET: "rws", DISCORD_BOT_TOKEN: "dt" };
  stripRunSecrets(env);
  assert.equal(env.RESEND_API_KEY, "re");
  assert.equal(env.RESEND_WEBHOOK_SECRET, "rws");
  assert.equal(env.DISCORD_BOT_TOKEN, "dt");
});

test("resend secrets are stripped from runs", () => {
  assert.ok(RUN_SECRET_ENV_VARS.includes("RESEND_API_KEY"));
  assert.ok(RUN_SECRET_ENV_VARS.includes("RESEND_WEBHOOK_SECRET"));
  assert.ok(!RUN_SECRET_ENV_VARS.includes("AGENTMAIL_API_KEY"));
});

