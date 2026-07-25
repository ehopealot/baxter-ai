# Baxter behavioral-regression evals

Catch "a prompt / skill / CLI change broke Baxter's judgment." Hold the **model**
fixed, vary the **code**; a regression is a drop in the suite's pass rate. Design
doc: [`docs/superpowers/specs/2026-07-25-baxter-eval-harness-design.md`](../../docs/superpowers/specs/2026-07-25-baxter-eval-harness-design.md).

## Run it

```bash
make eval                     # whole suite (needs OPENROUTER_API_KEY, from app/.env)
make eval SCENARIO=heartbeat  # only scenarios whose name contains "heartbeat"
make eval EVAL_SAMPLES=1       # one sample each (faster / cheaper)
EVAL_MODEL=openai/gpt-4o make eval   # a different pinned model
```

**This is not a unit test.** Each sample calls a **real model**, so the suite costs
money, hits the network, and is stochastic — it's a **pre-deploy / nightly gate**, not
something for every commit. (The *plumbing* — assertions, slot assembly, the mock
lookup, the threshold math — is pure and IS in the offline `node --test` suite.)

## How it works

Everything hangs off `runtime.mjs`'s `runAgent` — no Discord, no daemons:

```
scenario → render the REAL *-prompt.md via fillTemplate (synthetic slots)
         → runAgent(prompt, allowedTools, harness, model, cwd, onEvent=capture)
         → assert on the captured tool-call trace
```

**Hermetic:** a throwaway `cwd`, a `mockbin/` shadowing every CLI, and doctored
`allowedTools` (absolute `node <x>.mjs` grants converted to their PATH-friendly form)
so the openrouter runner resolves CLIs via PATH → the mocks, never the real ones. The
**only** unmocked thing is the model call — that's what we're measuring. Assertions are
**structural** (which tools ran, whether a reply went out, bounds), never reply
wording, so they're stable across samples; a scenario passes if ≥ ⌈2/3⌉ of its samples
pass.

## Add a scenario

Drop a `scenarios/NN-name.mjs` exporting a default object:

```js
import { calledTool, notCalledTool, delivered, succeeded, toolCallCount, replyMatches } from "../assertions.mjs";
export default {
  name: "discord: <what it checks>",
  surface: "discord",              // discord | mail | heartbeat
  seed: { memory: "...", credentials: "...", channelMemory: "..." },   // optional, seeds the cwd
  slots: { HISTORY: "[t] erik (msg msg1): ...", TRIGGER_AUTHOR: "erik" }, // template slots (override defaults)
  mocks: { "data-cli": '{"...":"canned"}', "web-cli": { "fetch": "canned page", "*": "" } }, // per-cli canned responses
  expect: [ calledTool("data-cli"), delivered(), notCalledTool("web-cli"), toolCallCount("<=", 6), succeeded() ],
  samples: 3,                      // optional (default 3 / EVAL_SAMPLES)
};
```

**Assertions** (`assertions.mjs`) — each is `(capture) => {pass, why}`:
`calledTool(cli[, sub])` · `notCalledTool(cli[, sub])` · `toolCallCount(cmp, n)` ·
`delivered()` · `succeeded()` · `replyMatches(/re/)` · `replyOmits(/re/)` ·
`custom(fn, desc)`. `calledTool` matches a native tool by name (`read_file`, …) or a
`run_cli` by its cli (+ optional subcommand).

Prefer **structural** assertions; use `replyMatches` only for a must-say substring. A
scenario that asserts a *judgment* (e.g. "routes to data-cli") is a **baseline** — run
it, note the pass rate, lock it in; a later drop is the regression signal.

## Layout

| File | |
|---|---|
| `assertions.mjs` (+`.test`) | `captureFromEvents` + the predicate library (pure) |
| `harness.mjs` (+`.test`) | the driver + pure pieces (`doctorTools`/`buildSlots`/`renderScenarioPrompt`/`passThreshold`/`formatTable`) and per-surface config |
| `mock.mjs` | the generic CLI mock (canned table + per-cli defaults) |
| `scenarios/*.mjs` | the suite (data) |
| `run.mjs` | the `make eval` entrypoint |

## Follow-ups (not yet built)

- Real-CLI opt-in per scenario (e.g. run the actual `projects-cli` to regression-test
  the CAS `--expect` flow, against the `HOME`-isolated cwd).
- Refactor the daemons' `renderPrompt` to be injectable, so the eval covers slot
  *assembly* (`renderHistory`/`skillsPreamble`/sanitization), not just the template.
- Separate **model-comparison** (promptfoo shines) and **security red-team** suites.
- Two capabilities the suite doesn't yet hit deterministically: the **browsers**
  (`playwright-cli`/`invisible-cli` — `web-cli` is the preferred path, so a scenario
  can't reliably force a browser) and **multimodal** Discord runs (needs the `BAXTER_MEDIA`
  attachment plumbing). The web/heartbeat scenarios accept a browser as a valid web path
  but don't require one.
