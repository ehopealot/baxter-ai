# Baxter behavioral-regression evals

These evals catch a change that broke Baxter's judgment (a prompt change, a
skill change, or a CLI change). Hold the model fixed. Vary the code. A
regression is a drop in the suite's pass rate. Design doc:
[`docs/superpowers/specs/2026-07-25-baxter-eval-harness-design.md`](../../docs/superpowers/specs/2026-07-25-baxter-eval-harness-design.md).

## Run it

```bash
make eval                     # whole suite (needs OPENROUTER_API_KEY, from app/.env)
make eval SCENARIO=heartbeat  # only scenarios whose name contains "heartbeat"
make eval EVAL_SAMPLES=1      # one sample each (faster and cheaper)
EVAL_MODEL=openai/gpt-4o make eval   # a different pinned model
```

This is not a unit test. Each sample calls a real model. So the suite costs
money, uses the network, and is stochastic. Use it as a pre-deploy or nightly
gate, not for every commit. The plumbing is pure and lives in the offline
`node --test` suite: the assertions, the slot assembly, the mock lookup, and the
threshold math.

## How it works

Everything hangs off `runtime.ts`'s `runAgent`. There is no Discord, and there
are no daemons.

```
scenario -> render the REAL *-prompt.md with fillTemplate (synthetic slots)
         -> runAgent(prompt, allowedTools, harness, model, cwd, onEvent=capture)
         -> assert on the captured tool-call trace
```

The run is hermetic. It uses a throwaway `cwd`, a `mockbin/` that shadows every
CLI, and doctored `allowedTools`. It converts each absolute `node <x>.ts` grant
to its PATH-friendly form. So the openrouter runner resolves each CLI through the
PATH to the mocks, never to the real ones. The only unmocked thing is the model
call. That is what the suite measures. The assertions are structural: which
tools ran, whether a reply went out, and bounds. They never check the reply
wording, so they stay stable across samples. A scenario passes when at least two
thirds of its samples pass.

## Add a scenario

Drop a `scenarios/NN-name.ts` file that exports a default object.

```js
import { calledTool, notCalledTool, delivered, succeeded, toolCallCount, replyMatches } from "../assertions.ts";
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

The assertions live in `assertions.ts`. Each one is `(capture) => {pass, why}`.
The set is `calledTool(cli[, sub])`, `notCalledTool(cli[, sub])`,
`toolCallCount(cmp, n)`, `delivered()`, `succeeded()`, `replyMatches(/re/)`,
`replyOmits(/re/)`, and `custom(fn, desc)`. `calledTool` matches a native tool
by name (`read_file`, and so on), or a `run_cli` by its cli with an optional
subcommand.

Prefer structural assertions. Use `replyMatches` only for a must-say substring.
A scenario that asserts a judgment (for example, "routes to data-cli") is a
baseline. Run it, note the pass rate, and lock it in. A later drop is the
regression signal.

## Layout

| File | |
|---|---|
| `assertions.ts` (+`.test`) | `captureFromEvents` and the predicate library (pure) |
| `harness.ts` (+`.test`) | the driver and its pure pieces (`doctorTools`/`buildSlots`/`renderScenarioPrompt`/`passThreshold`/`formatTable`), and the per-surface config |
| `mock.ts` | the generic CLI mock (a canned table and per-cli defaults) |
| `scenarios/*.ts` | the suite (data) |
| `run.ts` | the `make eval` entry point |

## Follow-ups (not yet built)

- A real-CLI opt-in per scenario. For example, run the real `projects-cli` to
  regression-test the CAS `--expect` flow, against the `HOME`-isolated cwd.
- Make the daemons' `renderPrompt` injectable, so the eval covers slot assembly
  (`renderHistory`, `skillsPreamble`, sanitization), not only the template.
- Split the model-comparison suite (promptfoo is good here) from the
  security red-team suite.
- The suite does not yet hit two capabilities in a deterministic way. The first
  is the browsers (`playwright-cli` and `invisible-cli`); `web-cli` is the
  preferred path, so a scenario cannot reliably force a browser. The second is
  the multimodal Discord runs; these need the `BAXTER_MEDIA` attachment
  plumbing. The web and heartbeat scenarios accept a browser as a valid web
  path, but they do not require one.
