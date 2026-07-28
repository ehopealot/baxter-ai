# Discord multimodal — route media posts to M3

**Date:** 2026-07-18
**Status:** design, pending implementation
**Surface:** Discord (message triggers only), openrouter harness only

## Problem

Baxter runs on a text-only model (`minimax/minimax-m2.7`). When a Discord
message carries media, the daemon builds the trigger + `{{HISTORY}}` transcript
from `m.content` **only** (`renderHistory`, `discord-bot.mjs`), so attachments
are dropped: an image-only post reaches Baxter as an empty body — he can't even
tell media exists. A run *can* discover attachment URLs via
`discord-cli fetch-history` (raw message JSON includes `attachments[]`), but a
text model still can't see them.

MiniMax **M3** is multimodal. Goal: when the triggering post carries media,
run *that turn* on M3 with the media attached to the prompt; keep M2.7 for
everything else (cost containment — M3 only when there's media to look at).

## Decisions (locked with the operator)

- **Scope:** the **trigger message's** attachments only (not history). A run can
  still `fetch-history` for more context.
- **Coalescing carry-forward:** `ChannelDispatcher._coalesce` keeps only the
  newest message per channel within the debounce window, so "post an image, then
  a text caption a second later" would make the *text* the trigger and silently
  drop the image (→ M2.7, and with no M2.7 marker, invisible). "Image then
  caption" is a common pattern, so this is unacceptable. Fix: `_coalesce` carries
  the superseded message's qualifying media **forward** onto the coalesced
  trigger (union `prev.media` + `next.media` in that **chronological** order,
  deduped by attachment `id`, truncated at `max` — so the older image survives
  even when the newer caption itself carries `max` attachments) — the same
  carry-forward precedent `_coalesce` already uses to escalate `respond` over a
  following `prefilter`.
  So media detection moves to **notify-time** (per message) so each dispatcher
  item carries its `media`, and the coalesced item keeps the union.
- **Media types:** images natively; **try** video / audio / PDF too ("let M3
  handle what it can"). Whether M3 accepts non-image modalities is
  model-dependent and unverified — the plumbing exists (see mapping), the model
  may ignore/err on some; that's acceptable.
- **No text marker on M2.7 runs:** text-only runs stay exactly as today
  (attachments invisible). Only the M3 path surfaces media.
- **Harness:** openrouter only (the live one). Local (chat/completions) harness
  unchanged — a possible later follow-up (different wire shape).
- **Reaction runs:** out of scope (message triggers only).

## Verified: SDK multimodal input shape

`@openrouter/agent`'s `callModel({ input })` accepts (per the installed
`@openrouter/sdk` models) an `EasyInputMessage` whose `content` is
`Array<InputText | InputImage | InputFile | InputAudio | InputVideo> | string`.
Wire (outbound, snake_case) shapes confirmed from the `.d.ts`:

| Discord `content_type` | SDK part | Fields (wire) | Transport |
|---|---|---|---|
| `image/*` | `input_image` | `{ type, image_url: "<url>", detail: "auto" }` | URL (server-side fetch) |
| `video/*` | `input_video` | `{ type, video_url: "<url>" }` | URL |
| `application/pdf` | `input_file` | `{ type, file_url: "<url>", filename }` | URL |
| `audio/*` | `input_audio` | `{ type, input_audio: { data: "<b64>", format } }` | **base64 (no URL)** |
| (text prompt) | `input_text` | `{ type, text }` | — |
| other | — | — | not represented → stays M2.7 |

`image_url` is a **bare URL string**, and `detail` is **required**. The key
asymmetry: image/video/pdf pass by URL (OpenRouter fetches them), but audio has
no URL field — the runner must download the bytes and base64-encode them, and
map the content_type to a `format`. The SDK's audio `FormatEnum`
(`inputaudio.d.ts`) names **only `mp3` and `wav`** — so `audio/mpeg`→`mp3`,
`audio/wav`→`wav` are the confirmed mappings; `audio/ogg`/`audio/mp4`/`audio/aac`
are best-effort (the enum is an `OpenEnum`, so a non-listed `format` passes
client-side validation but is server-unverified), under a size cap.

## Design

Split of responsibility: the **daemon** knows Discord (detect + collect
attachment metadata + route the model); the **runner** knows the SDK (build the
content parts, fetch audio bytes). No bytes cross the env — only metadata.

### 1. Config

- `OPENROUTER_MULTIMODAL_MODEL` (e.g. `minimax/minimax-m3`) — **empty disables
  the whole feature** (M2.7 handles everything, as today). Operator sets the
  exact slug.
- `DISCORD_MEDIA_MAX_ATTACHMENTS` (default 4) — cap on parts per run.
- `OPENROUTER_MEDIA_AUDIO_MAX_BYTES` (default 8 MB) — audio over this is skipped
  (base64 inflates tokens ~1.33× and audio has no server-side fetch).

### 2. Daemon (`discord-bot.mjs`)

- Pure helper `selectMediaAttachments(message, { max })` → `media[]`:
  - Scan `message.attachments` for `content_type` in the multimodal set
    (`image/*`, `video/*`, `audio/*`, `application/pdf`).
  - Host-validate each `url` is `cdn.discordapp.com` / `media.discordapp.net`
    (the URL comes from Discord's API so it always is — the check documents
    intent and hard-stops a future path that injects an arbitrary URL).
  - Return up to `max` items as `{ id, url, content_type, filename, size }`
    (the attachment `id` is the coalesce dedupe key; it's harmless in
    `BAXTER_MEDIA` too, so no need to strip it).
  - The helper takes a **gateway `Message`**: its `attachments` is a Discord.js
    **Collection** of `Attachment` (`.id`, `.contentType`, `.url`, `.name`,
    `.size`). NB a raw REST message uses different field names
    (`.content_type`/`.filename`, array not Collection) — but that shape only
    appears in `discord-cli fetch-history`, which the run consumes itself and
    never flows through this helper, so the helper stays gateway-only.
- **Detect at notify-time**, so coalescing can carry media forward: when a
  message enters the dispatcher, compute its `media` and put it on the item
  (`{ id, message, decision, media }`). `_coalesce` unions `prev.media` +
  `next.media` in that chronological order, deduped by attachment `id`, truncated
  at `max` (oldest-first, so the carried image survives), alongside the existing
  decision-escalation. So the coalesced trigger keeps an earlier post's image
  even when a later text message becomes the surface `message`.
- In `handleChannel`, from the coalesced item's `media`: if it's non-empty **and**
  `OPENROUTER_MULTIMODAL_MODEL` is set, add to the run env:
  - `BAXTER_MODEL_OVERRIDE=<multimodal model>`
  - `BAXTER_MEDIA=<json array of {id, url, content_type, filename, size}>`
  Mirrors how `BAXTER_EXPECT_REPLY` / `BAXTER_REPLY_REQUIRED` are already set
  per-run. Empty media → neither var → runner behaves exactly as today.

### 3. Runner (`openrouter-runner.mjs`)

- `const model = process.env.BAXTER_MODEL_OVERRIDE || process.env.OPENROUTER_MODEL;`
- After reading `prompt` from stdin: if `BAXTER_MEDIA` is present and non-empty,
  build the **first** `callModel`'s `input` as one user message —
  `[{ role: "user", content: [{ type: "input_text", text: prompt }, ...parts] }]`
  — instead of the bare string. No media → `input = prompt` (unchanged path).
- `buildMediaParts(mediaJson, { fetch, maxAudioBytes })` in **runner-common.mjs**
  (shared + testable): map each item by `content_type` to its part; re-validate
  the host; for audio, `await fetch(url)` → base64 (skip if over cap or fetch
  fails); skip anything unmappable. Best-effort: a bad item is dropped, never
  throws (a media post must still run).
- Nudge/resume calls are unchanged (text-only follow-ups; the image was seen on
  the first turn and lives in the resumed conversation state).

### 4. Everything downstream is untouched

Tools, the empty/unsent nudge loop, context-full trim+retry, out-of-tokens
handling, send caps — all operate on the same conversation regardless of the
first turn's input shape.

## Security

- **Host allowlist** (Discord CDN only) on every URL, in both the daemon
  (detection) and the runner (before use) — belt and suspenders, since the
  runner also *fetches* audio URLs directly.
- **Type allowlist** — only the four multimodal families are forwarded.
- **Caps** — attachment count and audio byte size, so a crafted post can't blow
  up cost/tokens.
- Not new exposure: the media was already public in an allowed channel; sending
  it to the model to view is the feature. The URL is signed + expiring, used
  promptly.

## Test plan

- `buildMediaParts` (unit, injected `fetch`): each content_type → correct wire
  shape; audio → base64 with the right `format`; host-allowlist rejects a
  non-Discord URL; over-cap audio skipped; unknown type dropped; a throwing
  fetch drops just that item.
- `selectMediaAttachments` (unit): picks only multimodal types from a gateway
  `Message`'s attachment Collection, respects the count cap, host-validates.
- `_coalesce` media union (unit): image message coalesced under a later
  text-only message keeps the image; the mixed case (both messages carry media,
  union over `max`) keeps the oldest-first items so the carried image survives;
  union is deduped by attachment `id`; decision-escalation still holds.
- openrouter-runner integration is hard (SDK, no mock server) — rely on the
  pure-helper coverage plus a live smoke test: post an image in Discord with
  `OPENROUTER_MULTIMODAL_MODEL` set, confirm the run uses M3 and describes the
  image; post text-only, confirm it stays on M2.7.

## Out of scope / follow-ups

- Local (chat/completions) harness multimodal (different wire shape).
- History/thread images; reaction-triggered media.
- Email (Gmail) attachments to M3.
