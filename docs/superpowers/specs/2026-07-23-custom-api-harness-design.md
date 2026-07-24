# Custom-API harness — "like local/openrouter, but against any LLM API with a key"

**Status:** draft (spec for review)
**Date:** 2026-07-23
**Related:** `docs/superpowers/specs/2026-07-17-openrouter-harness-design.md` (the structured-tool harness layer this builds on)

## Motivation

Baxter's brain is pluggable via `BAXTER_HARNESS`:

- **`claude`** — the Claude Code binary (native tools).
- **`openrouter`** — `@openrouter/agent`'s loop against OpenRouter (Responses-API shape).
- **`local`** — raw HTTP against any **OpenAI chat/completions** endpoint (Ollama/LM Studio/OpenAI/OpenRouter-in-chat-mode).

The gap: `local` is locked to **one wire format** — OpenAI chat/completions. An operator who wants to run Baxter on a provider whose **native** API is a *different* shape — most importantly **Anthropic's Messages API** (real Claude, by API key, without the Claude Code binary) or **Google's Gemini `generateContent`** — has no path. This spec adds a harness that drives *any* keyed LLM HTTP API by swapping only the **wire dialect**, reusing the entire structured-tool machinery (preamble, tools, executors, context-fitting, nudges, error classification).

The honest scope of "any API": in practice every hosted LLM API is one of three shapes — OpenAI-compatible (already served by `local`, and the near-universal lingua franca: Mistral/Cohere/Together/Groq/DeepSeek/Fireworks all offer it), **Anthropic Messages**, or **Gemini generateContent**. This harness ships the two big **non-OpenAI** dialects and makes a new one a small module, so together `local` + this harness cover essentially the entire market.

## Non-goals

- **Not** a fully config-templated wire format (operator supplies JSONPath for request/response). Tool-calling wire formats differ too much (tool schema, tool-result threading, id semantics, role names) to template safely; that path is brittle and untestable. A new provider shape is a ~60-line **dialect module**, not a rewrite — the same extensibility model the repo uses for data-cli sources, skills, and the harnesses themselves.
- **Not** a replacement for `local`. OpenAI-compatible endpoints stay on `local` (working, live, tested). This harness is specifically the *other* native shapes.
- **No streaming** (neither `local` nor `openrouter`-runner stream token-by-token to the daemon; they emit normalized JSONL events per turn). Same here.
- **No model escalation** in v1 (only the `openrouter` runner has `shouldEscalateModel`; `local` does not). We match `local`: context-full → trim-and-retry, then graceful stop. Escalation is a noted fast-follow.

## Naming (OPEN — flag for check-in)

Working name: **`BAXTER_HARNESS=custom`**, with the dialect chosen by `CUSTOM_API_DIALECT`. Alternatives considered:
- `BAXTER_HARNESS=api` (reads as "any api").
- Per-dialect registry entries (`BAXTER_HARNESS=anthropic`, `=gemini`) backed by the same runner. Reads naturally but is *N harnesses*, not "*a* harness against any api" (the user's phrasing was singular), and a custom proxy endpoint that merely speaks a known dialect wouldn't have a named harness.

Recommendation: **one `custom` harness, dialect as config** — it's the literal embodiment of "point it at any API." Final name is the operator's call; trivial to rename before merge.

## Architecture

A harness is a thin adapter (`name`/`describe`/`buildInvocation`/`parseEvents`/`detectOutcome`) that spawns a **runner** emitting the shared JSONL event protocol. `custom.mjs` mirrors `local.mjs`/`openrouter.mjs` exactly (spawns `custom-runner.mjs`, reuses `parseRunnerEvents`/`detectRunnerOutcome`). All the novelty is in the runner + dialects.

### The key idea: a NORMALIZED transcript, converted to wire per-call

`local-runner` mutates an **OpenAI-shaped** `messages` array in place, and `fitContext` is hardcoded to that shape (`m.role==="tool"`, `m.tool_calls[].function.arguments`). That doesn't generalize. So `custom-runner` keeps a **dialect-neutral normalized transcript** and asks the dialect to render it to the provider's wire format on each call:

```
Normalized transcript items (what the runner owns):
  { role: "user",      text }                                   // original prompt; nudges
  { role: "assistant", text, toolCalls: [{ id, name, args }] }  // a model turn
  { role: "tool",      results: [{ id, name, content }] }       // one bundle per assistant turn's calls
```

The runner's loop is dialect-independent; the dialect is four pure functions.

### Dialect interface (`harnesses/dialects/<name>.mjs`, pure + unit-tested)

```
defaultBaseUrl: string

// normalized transcript + tool specs -> a ready HTTP request. Pure: no fetch.
// body is a JS object (runner JSON.stringifies). apiKey placement (header vs
// query) is the dialect's job.
buildRequest({ baseUrl, model, apiKey, system, transcript, specs, maxOutputTokens })
  -> { url, headers, body }

// provider JSON response -> normalized turn. toolCalls[].args is a parsed object.
// Dialects lacking a tool-call id synthesize a stable one (gemini: name + index).
parseResponse(json) -> { text, toolCalls: [{ id, name, args }], stopReason }

// classify a NON-ok HTTP response for this dialect into the shared buckets, so the
// runner's generic handling (out-of-tokens vs context-full vs hard error) applies.
// Returns { kind: "out_of_tokens" | "context_full" | "auth" | "error", message }.
classifyError({ status, body }) -> { kind, message }
```

`system` (from `systemPreamble(cliMap)`) is passed separately because providers place it differently (OpenAI: a `system` message; Anthropic: top-level `system`; Gemini: `system_instruction`). Tool rendering lives **inside `buildRequest`** (each dialect renders `specs` to its own tool schema — Anthropic/OpenAI reuse `toJsonSchema(spec)` for `input_schema`/`parameters`; Gemini wraps the same under `function_declarations`), so the dialect owns its entire wire body.

### The runner loop (`custom-runner.mjs`)

Structurally identical to `local-runner`'s loop, but transcript-based. Reused **verbatim** from `runner-common`: `emit`, `note`, `argOf`, `readStdin`, `systemPreamble`, `toolSpecs`, `toJsonSchema`, `runTool`, `estTokens`, `isContextFullError`, `OUT_OF_TOKENS_RE`, `EMPTY_TURN_NUDGE`, `UNSENT_REPLY_NUDGE`, `isDeliveryCall`, `nudgeDecision`; executors from `openrouter-tools` via `toolSpecs`. Reused **behaviorally** (re-expressed over the normalized shape): the step cap, the empty-turn/unsent-reply nudges, the delivered-short-circuit (never retry/wrap-up after a real send → no duplicate), the wrap-up final turn with no tools, and context-fit-before-each-call + context-full trim-and-retry.

New (small, generic-over-transcript):
- `fitTranscript(transcript, maxTokens)` — the normalized-shape analog of `fitContext`: two oldest-first passes (stub oldest `tool.results[].content`, then oldest oversized `assistant.toolCalls[].args`), never dropping an item, never touching an id, never trimming items 0/1 (system is separate; item 0 is the original prompt). Returns whether it trimmed. Lives in `runner-common` next to `fitContext` (shared, tested).
- `callModel(transcript)` — `buildRequest` via the selected dialect → `fetch` (one `AbortController` over the request) → on `!res.ok`, `dialect.classifyError` → throw a tagged error the outer logic classifies; on ok, `dialect.parseResponse`.

Config (env; all `CUSTOM_API_*`, mirroring the `OPENAI_*`/`OPENROUTER_*` knob families):
- `CUSTOM_API_DIALECT` (required; `anthropic` | `gemini`) — unknown value fails hard at runner start.
- `CUSTOM_API_MODEL` (required).
- `CUSTOM_API_KEY` (required for hosted providers; the key).
- `CUSTOM_API_BASE_URL` (optional; defaults to the dialect's `defaultBaseUrl` — lets a proxy/self-host that speaks a known dialect be targeted).
- `CUSTOM_API_MAX_OUTPUT_TOKENS` (default 8192; Anthropic requires `max_tokens`, Gemini uses `maxOutputTokens`).
- Reused knob names, read generically: `CUSTOM_API_MAX_STEPS` (40), `CUSTOM_API_REQUEST_TIMEOUT_MS` (300000), `CUSTOM_API_CLI_TIMEOUT_MS` (120000), `CUSTOM_API_CLI_OUTPUT_MAX_BYTES` (256 KiB), `CUSTOM_API_CONTEXT_MAX_TOKENS` (0 = disabled; there's no single default window across dialects, so **off by default** and the daemons already bound history — differs from local's 24000), `CUSTOM_API_CONTEXT_RETRY_MAX` (2). `envInt` (fail-closed) as elsewhere.

### `describe()` for the startup log

Returns `"<dialect>:<model>"` (e.g. `anthropic:claude-sonnet-5`) so `harnessLabel` shows the real brain, like `local`/`openrouter` read their own model env.

## The two shipped dialects

### `anthropic` (headline)

- `defaultBaseUrl`: `https://api.anthropic.com`
- Request: `POST {base}/v1/messages`; headers `x-api-key: <key>`, `anthropic-version: 2023-06-01`, `content-type: application/json`.
- Body: `{ model, max_tokens, system, messages, tools }`.
  - `system`: the preamble string, top-level.
  - `messages`: user → `{role:"user", content:[{type:"text",text}]}`; assistant → `{role:"assistant", content:[ {type:"text",text}?, {type:"tool_use", id, name, input: args}... ]}`; tool bundle → `{role:"user", content:[ {type:"tool_result", tool_use_id: id, content: <string>}... ]}`.
  - `tools`: `[{ name, description, input_schema: toJsonSchema(spec) }]`.
- `parseResponse`: `text` = concatenated `content[].text`; `toolCalls` = `content[]` of `type:"tool_use"` → `{id, name, args: input}`; `stopReason` = `stop_reason` (`tool_use`/`end_turn`/`max_tokens`).
- `classifyError`: 401 → `auth`; 429 → `out_of_tokens`; 529 (overloaded) → `out_of_tokens` (retry-later, not a hard fail — the daemons' "couldn't get to this" path); 400 whose `error.message` matches `isContextFullError` (Anthropic says "prompt is too long", already in `CONTEXT_FULL_RE`) → `context_full`; else `error`.

### `gemini` (genericity proof — different roles, query-param auth, different tool shape)

- `defaultBaseUrl`: `https://generativelanguage.googleapis.com`
- Request: `POST {base}/v1beta/models/{model}:generateContent`; auth via **`x-goog-api-key: <key>`** header (preferred over `?key=` so the key never lands in a URL that could be echoed/logged).
- Body: `{ system_instruction:{parts:[{text}]}, contents, tools:[{function_declarations:[{name,description,parameters: toJsonSchema(spec)}]}], generationConfig:{maxOutputTokens} }`.
  - `contents`: user → `{role:"user", parts:[{text}]}`; assistant → `{role:"model", parts:[ {text}?, {functionCall:{name, args}}... ]}`; tool bundle → `{role:"user", parts:[ {functionResponse:{name, response:{result: content}}}... ]}`.
- `parseResponse`: from `candidates[0].content.parts` — `text` = joined `part.text`; `toolCalls` = `part.functionCall` → `{ id: name+"#"+index (synthesized), name, args }`; `stopReason` = `candidates[0].finishReason`.
- Note the id round-trip: Gemini has no call id and matches `functionResponse` by **name**, so `appendToolResults`/`buildRequest` key on `name`, not the synthesized id (the id is only for the runner's own bookkeeping/logging).
- `classifyError`: 429 / `RESOURCE_EXHAUSTED` → `out_of_tokens`; 400 `INVALID_ARGUMENT` matching context phrasing → `context_full`; 401/403 → `auth`; else `error`.

## Security posture

**No new attack surface vs the existing keyed harnesses — same design, extended.**

- `CUSTOM_API_KEY` lives in the **runner's env** and is deliberately **kept** (not added to `RUN_SECRET_ENV_VARS`), exactly like `OPENROUTER_API_KEY`/`OPENAI_API_KEY`: the runner process *is* the run and needs the key to call the model. On the structured-tool harness the run **cannot read its own env** — no shell, no `printenv`; `read_file`/`files-cli` are cwd-confined so `/proc/self/environ` (absolute, outside cwd) is refused; `code-cli` runs offline in the sandbox with no host env. So the key is unreadable by the model, same as today's provider keys. (This is the reasoning already recorded at `runtime.mjs`'s `stripRunSecrets`; the new key rides the identical rule.)
- The **enforced boundary is unchanged**: `allowedTools` → `parseAllowedTools` → the execFile allowlist + cwd-confined read/write/edit (`openrouter-tools.mjs`), reused verbatim. A new dialect changes only *which model* is called, never *what the run can do*.
- Dialects are **pure and do no I/O** (the runner owns `fetch`), so they're fully unit-testable and can't reach the filesystem/network themselves. `buildRequest` is where the key is placed — a dialect test asserts the key lands in the right header/field and **nowhere in the URL** (Gemini: header, not `?key=`).
- Responses are **untrusted model output** already (same as every harness); nothing new.
- `CUSTOM_API_BASE_URL` is **operator-only** config (env, not run-settable — the run has no shell and can't set a `CUSTOM_API_*` prefix through the `Bash(...)`-shaped grant), so pointing the harness at a proxy is an operator decision, like `OPENAI_BASE_URL`.

## Reused vs new (inventory)

| Piece | Source |
|---|---|
| Adapter shape, event decode, outcome detect | `parseRunnerEvents`/`detectRunnerOutcome` (`runner-events.mjs`), unchanged |
| System preamble, tool specs, JSON-schema render, `runTool`, nudges, delivery detect, classifiers | `runner-common.mjs`, unchanged |
| Executors + allowlist + cwd confinement | `openrouter-tools.mjs`, unchanged |
| Env passthrough | `env_file: [app/.env]` — new `CUSTOM_API_*` flow with no compose change |
| **New:** `custom.mjs` (adapter), `custom-runner.mjs` (transcript loop), `dialects/anthropic.mjs`, `dialects/gemini.mjs`, `dialects/index.mjs` (registry) | this spec |
| **New:** `fitTranscript` in `runner-common.mjs` (normalized-shape context trim) | this spec |
| **Changed:** one registry line in `runtime.mjs` (`custom: customHarness`); `.env.example` section; `app/CLAUDE.md` Discord-bot harness paragraph | this spec |

## Testing plan (TDD — write these first)

1. **`dialects/anthropic.test.mjs`, `dialects/gemini.test.mjs`** (pure, no network):
   - `buildRequest`: correct URL/method; key in the right header and **not in the URL**; `system` placed correctly; a mixed transcript (user, assistant-with-text-and-two-tool-calls, tool-bundle, user-nudge) renders to the exact wire shape; tool specs render to the dialect's tool schema; `maxOutputTokens` present where required.
   - `parseResponse`: text-only turn; tool-call turn (ids preserved/synthesized); mixed text+tool_use; empty/degenerate content → `{text:"", toolCalls:[]}`.
   - `classifyError`: 401→auth, 429→out_of_tokens, 529→out_of_tokens (anthropic), context phrasing→context_full, other→error.
   - Round-trip: `parseResponse` output → normalized transcript → `buildRequest` produces a valid next request (esp. Gemini's name-keyed `functionResponse`).
2. **`custom-runner.test.mjs`** (loop with an injected `fetch` stub + a fake dialect, mirroring `local-runner.test.mjs`): a tool-call-then-final-text run emits the right events + a success result; an empty turn nudges then finishes; delivered-then-error is treated as done (no duplicate send); step-cap forces a no-tools wrap-up; a context-full stub triggers `fitTranscript`+retry then graceful stop; a 429 → out-of-tokens result (exit 0); an auth error → hard fail (exit 1).
3. **`fitTranscript`** unit tests in `runner-common.test.mjs`: trims oldest tool-result content first, then oldest oversized tool-call args, preserves items 0/1 and all ids, no-op under budget / 0-budget.
4. Full suite green: `node --test` from `app/`.

## Rollout

Docs-and-code only until an operator sets `BAXTER_HARNESS=custom` + the `CUSTOM_API_*` vars, so it ships dark (default stays `openrouter` on the box). Manual validation before calling it done: from `app/`, run `custom-runner` once per dialect against the real API with a scratch key + a trivial prompt (a `code-cli` call + a final message), confirming a normalized event stream and a clean `result`. Then `baxter shell` on the box with the harness set, one real chat turn.

## Open questions (for the check-in)

1. **Name**: `custom` vs `api` vs per-dialect harnesses (see Naming).
2. **Ship an `openai` dialect too?** It would duplicate `local`'s wire format; the argument for it is a single reference dialect + letting the `custom` loop's transcript-trim serve OpenAI endpoints too. Leaning **no** (avoid duplication; `local` stays the OpenAI path). Easy to add later.
3. **Third dialect now or later?** Anthropic + Gemini prove the abstraction and cover the non-OpenAI market. More (Cohere native, etc.) on request.
4. **Model escalation / fallback** (`CUSTOM_API_FALLBACK_MODEL`): skipped in v1 to match `local`. Want it in v1?
