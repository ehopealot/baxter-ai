# The mail agent

The mail surface is a Resend-backed daemon. Inbound mail travels through the Resend webhook to the Worker `/mail/inbound` endpoint, where Svix signatures are verified, the recipient is routed, and the raw webhook is placed in the Durable Object queue. A SigV4-authenticated `/mail-link` socket delivers queued payloads to the container. `scripts/mail-bot.ts` reconstructs the signed request, re-verifies it through the Resend Chat SDK adapter, and dispatches one scoped Baxter run for each allowlisted inbound thread. There is no polling loop and no AgentMail dependency.

Provisioning is handled by `baxctl add`/`baxctl home`: for tenants with the mail surface enabled, baxctl derives `BAXTER_EMAIL` as `<id>@<domain>` from the verified `RESEND_DOMAIN`. There is no inbox-provisioning command.

## File map

- **`scripts/mail-bot.ts`** — the container daemon. It maintains the durable queue cursor and signed link, verifies inbound webhook payloads through the Resend adapter, durably admits each accepted agent envelope before cursor acknowledgement, records dead letters, and dispatches scoped runs with the thread id, body, and attachment metadata. Interrupted dispatches replay from the admission outbox after restart.
- **`scripts/mail-cli.ts`** — the credential boundary. `reply` and `send` use the Resend Chat SDK with provider guards; `send-calendar` sends an `.ics` attachment; `get-attachment <emailId> <filename>` mints and fetches a Resend receiving-attachment URL. The CLI is the only mail-run path allowed to hold the Resend API key.
- **`scripts/mail-transcript.ts`** — durable transcript and thread Message-ID index, used to preserve context and reply headers across runs.
- **`scripts/mail-state-sqlite.ts`** — per-tenant SQLite state for the Chat SDK adapter, including deduplication and thread state.
- **`scripts/queue-admission-outbox.ts`** — immutable per-sequence agent-admission envelopes and their durable dispatch outcomes; mail replays pending/retry or interrupted envelopes without re-admitting them.
- **`scripts/home-link.ts`** — signed WebSocket transport to the Worker Durable Object.
- **`scripts/paths.ts`** — centralized paths for the mail state database, link cursor, transcript, and key material.
- **`prompt.md`** — the mail eval template. Production mail runs build their prompt inline in `mail-bot.ts`; both flows use thread ids for replies and expose on-demand attachment retrieval.

## Security and delivery boundaries

- The Worker verifies the Svix webhook before routing by recipient; the container verifies the same signed request again through the Resend adapter.
- The mail bot rejects own messages, automated messages, and senders outside the tenant allowlist/operator address. It records failures in the mail dead-letter queue and advances the cursor only after handling or dead-lettering.
- `mail-cli.ts` keeps `RESEND_API_KEY` out of model-run environments, locks the sender to `BAXTER_EMAIL`, checks recipient allowlists, sanitizes content, and enforces the daily send cap.
- Inbound attachment metadata is shown to the agent. When a multimodal model is configured (`OPENROUTER_MULTIMODAL_MODEL`), forwardable attachments (image/video/audio/PDF) are additionally attached to the run natively — `selectMailMedia` mints a short-lived signed URL per attachment and routes that one run to the multimodal model (URL-passthrough; see the harness-layer multimodal-routing note). The agent can still fetch any named attachment on demand with `mail-cli get-attachment <emailId> <filename>` (the fallback for anything not forwarded), rather than receiving arbitrary provider URLs in the prompt.
