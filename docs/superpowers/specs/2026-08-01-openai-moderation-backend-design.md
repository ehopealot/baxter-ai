# OpenAI moderation-endpoint backend (dedicated classifier for content moderation)

**Goal:** Add a **dedicated content-classifier backend** — OpenAI's
`/v1/moderations` endpoint — as an env-selectable alternative to the current
general-LLM verifier in `scripts/moderation.ts`. Same fail-open posture, same
IN/OUT hook points; faster, free, and far less timeout-prone.

## Background & motivation

Today `moderation.ts` moderates each message (inbound Discord/email + Baxter's
outbound replies) with **one small general-LLM call** to an OpenAI-compatible
`/chat/completions` endpoint (default via OpenRouter): a fixed policy prompt asks
the model to reply `ALLOW` or `BLOCK <category>: <reason>`, parsed into a
`Verdict`. Design posture is **fail-open** — a disabled check, misconfig,
verifier error/timeout, or unparseable reply all resolve to ALLOWED with a loud
`alert`.

Observed on the hopefam tenant: a real fail-open event —
`moderation ALERT: verifier call failed (This operation was aborted)` — i.e. the
general chat model **timed out** and the message was allowed unchecked. This is
the general-verifier pattern's weak spot: a chat model is the slowest, priciest,
least consistent, most timeout-prone way to answer "is this clearly abusive?",
and every timeout silently degrades moderation toward fail-open.

A **purpose-built moderation classifier** fixes all four:

- **Free** — OpenAI does not bill `/v1/moderations`, so it doesn't touch the
  OpenRouter budget or the usage ledger.
- **Fast + reliable** — ~100–300ms, essentially never times out (kills the
  fail-open gaps).
- **Consistent + not an injection surface** — it classifies content; content
  can't instruct it (the general verifier needs an injection guard for a reason).
- **Structured output** — per-category booleans + 0–1 scores, richer and more
  stable than a parsed free-text reply.

**Trade-off / dependency:** it requires an **OpenAI API key** (it's an OpenAI
product, not on OpenRouter). Confirmed available for these tenants. Message text
goes to OpenAI (already true of the current verifier, which posts to a model).

## Scope (v1)

- **Add** a second moderation backend selected by `MODERATION_BACKEND`
  (`llm` = current, default | `openai` = the moderations endpoint). Fully
  additive and reversible; the LLM verifier stays the default.
- **Text-only**, matching today. (OpenAI's `omni-moderation-latest` also
  classifies **images** — a natural follow-up given Baxter's attachments — but
  wiring attachment bytes into moderation is out of scope here; see Non-goals.)
- Reuse the existing IN/OUT hook points, `moderate()` gates (`MODERATION_ENABLED`
  + per-direction), fail-open behavior, and the injectable `alert`/timeout seams
  unchanged. Only the classification step changes.

## The one real decision: the family threshold policy

OpenAI returns, per message: `flagged` (its own threshold), `categories.{...}`
(booleans), and `category_scores.{...}` (0–1) across `harassment`,
`harassment/threatening`, `hate`, `hate/threatening`, `sexual`, `sexual/minors`,
`violence`, `violence/graphic`, `self-harm`, `self-harm/intent`,
`self-harm/instructions`, `illicit`, `illicit/violent`.

**Do NOT block on `flagged` alone.** This is a **family** tool — the failure
mode we care about is *false positives censoring normal teasing/venting*, not
missing edge cases. So v1 policy:

- **Hard-block set** (block if the category's score ≥ a *low* threshold): the
  clearly-unsafe categories — `sexual/minors`, `hate/threatening`,
  `violence/graphic`, `self-harm/instructions`. These should essentially never
  appear in a family channel and warrant blocking on weak signal.
- **Soft set** (everything else — `harassment`, `hate`, `sexual`, `violence`,
  `self-harm`, `illicit`): block only above a **high** score threshold, so
  ordinary family banter isn't flagged.

Tunable knobs:

| Var | Default | Meaning |
|---|---|---|
| `MODERATION_HARD_THRESHOLD` | `0.5` | score at/above which a hard-block category blocks |
| `MODERATION_SOFT_THRESHOLD` | `0.85` | score at/above which a soft category blocks |

The hard/soft category *membership* is a small in-code policy map (documented
constant), not env — it's a safety stance, not routine tuning. **This threshold
policy is the piece to review/tune together; the plumbing is mechanical.** Same
policy applies both directions (in and out) in v1.

**Category → Verdict mapping** (the existing `Verdict.category` enum is
`profanity | harassment | sexual | violence | other`): `sexual*` → `sexual`;
`harassment*` → `harassment`; `hate*` → `harassment`; `violence*` → `violence`;
`self-harm*`/`illicit*` → `other`. The blocked `Verdict.reason` names the
triggering OpenAI category + score (e.g. `"sexual/minors 0.91"`).

## Components

### `scripts/moderation.ts`

Refactor the classification step behind a small backend abstraction so the two
paths are parallel and the existing tests keep passing:

- Introduce `type ModerationBackend = (text: string, direction: Direction, cfg: Cfg, signal: AbortSignal) => Promise<Verdict>`.
  - **`llmBackend`** — the current `defaultVerifier` chat call + `parseVerdict`,
    wrapped to return a `Verdict`. **Timeout ownership moves up:** `moderate()`
    builds ONE `AbortController` per call from `cfg.timeoutMs` and passes its
    `signal` to the selected backend, so `defaultVerifier` is refactored to
    *accept* the signal instead of constructing its own timer (today it builds
    its own at `moderation.ts:133-134`). The injected `opts.call`/`VerifierCall`
    test seam gains the `signal` param and its existing tests are updated
    accordingly — the *behavior* (one timeout, fail-open on abort) is identical,
    but the seam shape changes, so call it out rather than claiming "unchanged."
  - **`openaiModerationBackend`** — POST `{openaiBaseUrl}/moderations` with
    `{ model: openaiModel, input: text }` and `Authorization: Bearer <openaiKey>`;
    read `results[0].category_scores` + `.categories`; apply the threshold policy
    (pure `classifyOpenAiResult(result, cfg) -> Verdict`, unit-tested). A non-2xx
    / network error / timeout (via the passed `signal`) **throws** — `moderate()`'s
    existing catch turns it into allow + `alert` (fail-open preserved).
- **`loadModConfig`** (the real loader, `moderation.ts:71` — NOT `cfgFromEnv`)
  gains: `backend` (`MODERATION_BACKEND`, default `"llm"`), `hardThreshold`,
  `softThreshold`, and **backend-scoped OpenAI vars** (see below).
- **Do NOT overload the LLM-backend vars.** `MODERATION_MODEL` /
  `MODERATION_BASE_URL` / `MODERATION_API_KEY` are documented + set to
  OpenRouter/chat-model values on every currently-enabled tenant; if the openai
  backend reused them, flipping `MODERATION_BACKEND=openai` would POST a stale
  chat-model id (and an OpenRouter base/key) to `/moderations` → 401/4xx on
  **every message** → permanent fail-open — the exact gap this spec exists to
  close. So the openai backend reads its **own** vars:
  - `MODERATION_OPENAI_MODEL` (default `omni-moderation-latest`)
  - `MODERATION_OPENAI_BASE_URL` (default `https://api.openai.com/v1`)
  - `MODERATION_OPENAI_API_KEY` (**required**, no `OPENROUTER_API_KEY` fallback)

  When `MODERATION_BACKEND=openai`, the LLM-backend vars are ignored. The
  misconfig gate must key off the ACTIVE backend's config (the existing
  `!cfg.model || !cfg.apiKey` check at `moderation.ts:171` would otherwise
  false-alarm on an unset `MODERATION_MODEL` even though the openai backend has a
  model default) → alert-fail-open only when the *active* backend's key/model
  is missing.
- `moderate()` selects the backend from `cfg.backend` (default `llm`); everything
  else — the `MODERATION_ENABLED` gate, per-direction enable, fail-open, and
  `alert` — is unchanged and shared across both backends.

### Config (`.env.example`)

Document under the existing moderation block:

```
# Backend: llm (default, a general verifier model -- uses MODERATION_MODEL/BASE_URL/
# API_KEY above) | openai (OpenAI /v1/moderations, a dedicated free classifier --
# faster + more reliable; uses its OWN vars below, needs an OpenAI key).
#MODERATION_BACKEND=openai
#MODERATION_OPENAI_API_KEY=sk-...               # an OpenAI key (required for the openai backend)
#MODERATION_OPENAI_MODEL=omni-moderation-latest
#MODERATION_OPENAI_BASE_URL=https://api.openai.com/v1
#MODERATION_HARD_THRESHOLD=0.5                  # clearly-unsafe categories block on weak signal
#MODERATION_SOFT_THRESHOLD=0.85                 # everything else needs a strong signal (family-lenient)
```

## Testing

- **`classifyOpenAiResult` (pure):** a `sexual/minors` at 0.6 blocks (hard, low
  threshold); a `harassment` at 0.6 ALLOWS but at 0.9 blocks (soft, high
  threshold); a clean result (all low) allows; the `Verdict.category` mapping +
  reason string are correct; an all-below-threshold `flagged:true` result still
  ALLOWS (we don't trust bare `flagged`).
- **`openaiModerationBackend` (injected fetch):** maps a well-formed API response
  to the right verdict; a non-2xx / malformed body / timeout **throws** (so
  `moderate()` fail-opens + alerts); posts to `/moderations` with the model+key.
- **`moderate()` selection:** `MODERATION_BACKEND=openai` routes to the OpenAI
  backend; default/unset routes to the LLM backend; `openai` backend with no
  `MODERATION_OPENAI_API_KEY` → allow + alert (misconfig gate keys off the ACTIVE
  backend, and there is no OpenRouter fallback for this backend).
- Existing `moderation.test.ts` LLM-path cases stay green (the refactor is
  behavior-preserving for `llm`) — including the `opts.call`/`VerifierCall`
  seam updated for the new `signal` param.

## Non-goals / follow-ups

- **Image moderation.** `omni-moderation-latest` accepts image inputs; extending
  moderation to Baxter's image/PDF attachments (currently text-only) is a
  natural follow-up but needs the attachment→moderation plumbing — separate task.
- **Other backends** (Google Perspective, Mistral moderation, Llama-Guard-via-
  OpenRouter as a no-new-key option) — the backend abstraction leaves room, but
  v1 ships only `llm` + `openai`.
- **Per-direction / per-category policy divergence** — v1 uses one policy for
  both directions; splitting inbound vs outbound thresholds is a later tuning knob.
- **Deleting the LLM backend** — kept as the default and fallback; no removal.
