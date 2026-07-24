// Dialect registry for the custom-API harness. A dialect is the ONLY provider-
// specific piece (wire format); everything else -- the loop, tools, executors,
// context-fit, nudges, error classification -- is shared in custom-runner.mjs +
// runner-common.mjs. Adding a provider shape is one entry here + a ~60-line module,
// PLUS updating the hardcoded dialect set everywhere else so the switcher + docs accept
// it. Every file that hardcodes the set carries the literal token at least once, so
// `git grep -Fl 'anthropic|gemini'` lists them all (the Makefile `use-custom` guard,
// bin/baxter, README, .env.example, CLAUDE.md, runtime.mjs, and the runner/adapter);
// open each and update its dialect mentions. Keep any new site grep-able the same way.
//
// NOTE: OpenAI chat/completions is intentionally NOT here -- that shape is the
// `local` harness. This harness is the OTHER native shapes; together they cover
// essentially every hosted LLM API (most third parties also expose OpenAI-compat).
import * as anthropic from "./anthropic.mjs";
import * as gemini from "./gemini.mjs";

export const DIALECTS = { anthropic, gemini };

export function getDialect(name) {
  const d = Object.hasOwn(DIALECTS, String(name || "")) ? DIALECTS[name] : null;
  if (!d) {
    throw new Error(`Unknown CUSTOM_API_DIALECT "${name}" (known: ${Object.keys(DIALECTS).join(", ")})`);
  }
  return d;
}
