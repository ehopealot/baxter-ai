// TDD (red until implemented): the central run-env credential strip (spec
// Finding 2). runtime.mjs's runAgent is the one spawn path all four daemons
// (poll/discord/heartbeat/voice) go through, so stripping the surface secrets
// there covers every run at once -- instead of each daemon remembering to.
// See docs/superpowers/specs/2026-07-22-agentmail-migration-design.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripRunSecrets } from "./runtime.mjs";

test("stripRunSecrets removes the surface credentials but keeps the model-provider keys", () => {
  const env = {
    AGENTMAIL_API_KEY: "am", // full authority via the mail CLI file-fallback -> must not reach a run's env
    DISCORD_BOT_TOKEN: "dt", // ditto via discord-cli's file fallback
    OPENROUTER_API_KEY: "or", // on the openrouter/local harness the runner IS the run -> needs this
    OPENAI_API_KEY: "oa",
    PATH: "/usr/bin",
    BAXTER_EXPECT_REPLY: "1",
  };
  const out = stripRunSecrets(env);
  assert.equal(out.AGENTMAIL_API_KEY, undefined);
  assert.equal(out.DISCORD_BOT_TOKEN, undefined);
  assert.equal(out.OPENROUTER_API_KEY, "or");
  assert.equal(out.OPENAI_API_KEY, "oa");
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.BAXTER_EXPECT_REPLY, "1");
});

test("stripRunSecrets does not mutate the caller's env (the daemon's own process.env stays intact)", () => {
  const env = { AGENTMAIL_API_KEY: "am", DISCORD_BOT_TOKEN: "dt" };
  stripRunSecrets(env);
  assert.equal(env.AGENTMAIL_API_KEY, "am");
  assert.equal(env.DISCORD_BOT_TOKEN, "dt");
});
