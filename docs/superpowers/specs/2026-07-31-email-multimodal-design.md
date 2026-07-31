# Email multimodal routing (attachments → the multimodal model)

**Goal:** When an inbound email carries an image / PDF / audio attachment and
`OPENROUTER_MULTIMODAL_MODEL` is set, route that one run to the multimodal model with
the attachment(s) attached — exactly the behavior Discord already has, extended to the
mail poller.

## Background

Discord already does this (see `2026-07-18-discord-multimodal-m3-design.md` and the
harness essay's "Multimodal routing" section): the gateway detects media on the trigger
post (`selectMediaAttachments`, host-validated to the Discord CDN, type/count-capped),
and passes it to the run via two env vars — `BAXTER_MODEL_OVERRIDE` (the multimodal
model) and `BAXTER_MEDIA` (JSON media items). The **openrouter runner** reads
`BAXTER_MEDIA`, turns it into `@openrouter/agent` content parts (`buildMediaParts`), and
makes the first turn a structured multimodal message. Empty knob or a media-less trigger
→ the default text model, unchanged. Routing is **openrouter-harness only** (the other
runners don't read `BAXTER_MEDIA`); openrouter is the default harness.

The mail poller (`poll.ts`) currently drops attachments entirely: `mail.ts`'s
`FullMessage`/`ThreadOutput` don't carry them, and `poll.ts`'s `runAgent` env sets no
media vars.

## The one real difference: no CDN URL for email

A Discord attachment arrives with a `cdn.discordapp.com` URL that OpenRouter can fetch
directly (image/video/pdf are URL-passthrough; only audio is fetched+base64 by us). An
**AgentMail attachment has no public URL** — the `Message.attachments[]` entries carry
only `{ attachmentId, filename?, size, contentType? }`. Bytes are reached via
`client.inboxes.messages.getAttachment(inboxId, messageId, attachmentId)`, which mints a
short-lived signed `downloadUrl` (+ `expiresAt`).

So email cannot use URL-passthrough. Instead, **every email attachment is fetched and
base64-encoded**, then handed to the model as a data-URI content part (image/pdf) or
base64 audio (the same path Discord audio already uses). This also keeps the presigned
AgentMail URL from being handed to OpenRouter — OpenRouter only ever sees base64 bytes.

**Who fetches:** the openrouter runner fetches the `downloadUrl` (it's a presigned public
URL, no key needed) and base64-encodes it, inside `buildMediaParts`. `mail.ts` — the
AgentMail credential boundary — is what *mints* the `downloadUrl` (that call needs the
key). The URL is minted lazily (only when routing will actually happen) and rides
`BAXTER_MEDIA` (small: a URL + metadata, never the bytes), so no env-size blowup.

## Scope (v1)

- **Types:** image/\*, application/pdf, audio/\* → routed & attached. **video/\* is
  out** for email v1 (base64 video is large and poorly supported; rare over email) — it
  still gets a transcript marker so the agent knows it arrived.
- Only the **trigger** message's attachments are forwarded (mirrors Discord forwarding
  only the trigger post's media).
- **Caps:** `MAIL_MEDIA_MAX_ATTACHMENTS` (default 4, like Discord) and a per-attachment
  byte cap `MAIL_MEDIA_MAX_BYTES` (default 8 MiB) enforced both on the declared `size`
  and the fetched length.
- **Config:** reuses `OPENROUTER_MULTIMODAL_MODEL` — the same single knob enables both
  surfaces. Unset → email attachments are surfaced as markers only (no routing), exactly
  as a media-less email behaves today.
- **Not moderated:** attachment *content* isn't run through moderation (moderation v1 is
  text-only; inbound moderation still runs on the trigger's text). Consistent with
  Discord.

## Components

### `mail.ts`
- `MailAttachment` interface `{ attachmentId, filename?, contentType?, size }`.
- `FullMessage.attachments?: MailAttachment[]`; `mapAttachments(raw)` (pure, defensive)
  maps `full.attachments` in the `messages.get` mapping.
- `ThreadOutput.attachments: MailAttachment[]` — the trigger message's attachments
  (empty array if none). Metadata only; no bytes, no URL.
- New CLI subcommand **`get-attachment <messageId> <attachmentId>`** → JSON
  `{ attachmentId, filename, contentType, size, downloadUrl, expiresAt }` (mints the
  presigned URL via `getAttachment`). This is the credential-holding step.

### `poll.ts`
- Renders a sanitized `{{ATTACHMENTS}}` marker line into the prompt from
  `thread.attachments` (attacker-influenced filenames/types are neutralized like
  `{{FROM}}`/`{{SUBJECT}}` already are), so a text run — routing off, or a type that
  doesn't forward — still knows media arrived.
- Before `runAgent`: if `OPENROUTER_MULTIMODAL_MODEL` is set, `selectMailMedia` filters
  the trigger's attachments to the forwardable types and caps the count; for each it
  shells `mail.ts get-attachment` to mint the `downloadUrl`, assembles
  `BAXTER_MEDIA` items `{ attachmentId, url, content_type, filename, size, source:"email" }`,
  and sets `BAXTER_MODEL_OVERRIDE=OPENROUTER_MULTIMODAL_MODEL` + `BAXTER_MEDIA` in the run env.

### `runner-common.ts` (`buildMediaParts`)
- `MediaItem` gains `source?: "discord" | "email"` (absent ⇒ discord, unchanged).
- `isMultimodalContentType(ct)` shared helper (image/video/audio/pdf) — used by
  `poll.ts`'s selection.
- For an **email** item: skip the Discord-CDN host gate; require an `https:` URL; fetch
  the bytes (size-capped by `maxMailBytes`), and build:
  - image/\* → `input_image` `{ imageUrl: "data:<ct>;base64,<b64>" }`
  - application/pdf → `input_file` `{ fileUrl: "data:application/pdf;base64,<b64>", filename }`
  - audio/\* → `input_audio` `{ data: <b64>, format }` (same as Discord audio)
  - anything else (incl. video) → skipped with a note.
  Best-effort per item (a failed/oversized fetch drops just that item, never throws) —
  a media email must still run.
- The Discord path (`source` absent) is untouched: CDN-gated URL-passthrough +
  base64 audio.

### openrouter-runner
- Already reads `BAXTER_MEDIA` and calls `buildMediaParts`; just also passes the new
  `maxMailBytes` cap (`OPENROUTER_MEDIA_MAIL_MAX_BYTES`, default 8 MiB). No other change —
  email items flow through the same first-turn assembly and the same model override.

## Testing

- `mapAttachments`: maps a well-formed list; defends against garbage entries; no-op on absent.
- `buildThreadOutput`: carries the trigger's attachments (and only the trigger's).
- `isMultimodalContentType`: image/video/audio/pdf yes; text/other no.
- `selectMailMedia`: keeps forwardable types, drops the rest, caps the count.
- `buildMediaParts` email branch: image→data-URI input_image, pdf→data-URI input_file,
  audio→base64 input_audio; skips a non-https url, an over-cap item, a failed fetch, and
  video — never throws; Discord path unchanged.
- attachments marker rendering (pure) + its sanitization in poll.

## Non-goals / follow-ups

- Video over email (skipped v1).
- Moderating attachment *content* (text-only moderation stands).
- The `openai`/`custom` harnesses (they don't wire `BAXTER_MEDIA` for Discord either;
  a separate change if wanted).
- A tighter `downloadUrl` host allowlist (URLs are AgentMail-minted from our authed call
  and never reach OpenRouter, so https + our-minted is the trust boundary for v1).
