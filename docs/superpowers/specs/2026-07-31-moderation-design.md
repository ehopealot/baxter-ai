# Content moderation (verifier calls) — design

**Goal.** Optional safety checks on messages **in** (Discord + email) and **out** (Baxter's
replies): reject unsafe/profane inbound, and stop Baxter sending something objectionable.
Off by default, enabled by an env flag. Each check is a **single small model call** — a fixed
policy prompt + the *one* message, nothing else (no thread/transcript) — so it's cheap.

## Mechanism

**`scripts/moderation.ts`** — one function:

```ts
export type Direction = "in" | "out";
export interface Verdict { allowed: boolean; category?: string; reason?: string; }
export async function moderate(text: string, direction: Direction, env?: NodeJS.ProcessEnv): Promise<Verdict>;
```

- **Disabled → `{ allowed: true }` with no network call.** Gated by `MODERATION_ENABLED`
  (master, default off) and optional per-direction `MODERATION_INBOUND` / `MODERATION_OUTBOUND`
  (default: follow the master).
- **The call:** an OpenAI-compatible chat completion (reusing the OpenRouter config), model set
  by `MODERATION_MODEL`, a tiny fixed **policy prompt** + the single message. The model replies
  `ALLOW`, or `BLOCK <category>: <short reason>`. `category` ∈ a small fixed set
  (`profanity | harassment | sexual | violence | other`); an unrecognized category folds to
  `other`. Parsing is lenient (case-insensitive, tolerates surrounding text) and defaults to
  **allow** if the reply is unparseable (a garbled verdict must not silently censor).
- **Fail-open + alert.** On a verifier error/timeout (`MODERATION_TIMEOUT_MS`, default ~4s), the
  message is **allowed** and a loud operator alert is logged. Availability over strictness for a
  family tool; the outage window is unchecked, not broken.
- Config (all env, reachable at every hook point — daemons have full env, the send-CLIs inherit
  the runner env): `MODERATION_ENABLED`, `MODERATION_INBOUND`, `MODERATION_OUTBOUND`,
  `MODERATION_MODEL`, `MODERATION_API_KEY` (fallback `OPENROUTER_API_KEY`), `MODERATION_BASE_URL`
  (default OpenRouter), `MODERATION_TIMEOUT_MS`, and optional prompt overrides
  `MODERATION_INBOUND_PROMPT` / `MODERATION_OUTBOUND_PROMPT`.

## Hook points

**Inbound** — before a run is spawned:
- **Email** (`poll.ts`, per new thread before `runAgent`) and **Discord** (`discord-bot.ts`,
  after `classifyMessage` says handle, before dispatch) moderate the incoming message text.
- **Blocked → don't spawn a run.** Reply with a **canned line chosen by category** (a couple of
  friendly variants each — kept tasteful, editable in one map), delivered by the daemon directly
  (bypasses outbound moderation, since it's our own safe text). Log + alert. The reply **respects
  the daily send cap** (`recordDiscordSend` / `mail`'s `recordSend`), and the inbound check runs
  at the run-dispatch point already bounded by the per-channel hourly run budget (Discord —
  `handleChannel`) / `MAX_EMAILS_PER_CYCLE` + poll interval (email) — so a flood produces at most
  one verifier call + one canned reply per already-budgeted run, not an unbounded 1:1.

**Outbound** — agent-originated sends only:
- **Discord** (`discord-cli` — the send functions `sendMessage`/`sendWithFiles`, which cover
  send/reply/dm/send-thread, **plus** the `edit` content and the `create-thread` name, both of
  which set model-authored text without going through `sendMessage`) and **email** (`mail`
  `performSend`/`performReply`) moderate the content the agent is trying to send.
- **Blocked → do NOT send the content.** Return a structured error to the agent: *this was
  blocked by the safety filter (<reason>); do not resend it — send a brief apology that you
  can't help with that instead.* The agent's apology re-passes moderation trivially, so the user
  hears the decline in Baxter's own voice. Log + alert.
- **Daemon-origin control messages bypass:** the daemon posts via `client.rest` (Discord) or
  the low-level `performReply` reached through the normal `mail` CLI, so its own inbound canned
  replies aren't a separate hidden path. `edit` closes the post-benign-then-edit bypass.

## Non-goals / notes

- This is **content** moderation, layered on top of the existing **access** control (both
  surfaces already allowlist senders/recipients). It's belt-and-suspenders for a family setting
  (e.g. kids in the channel), not the primary access boundary.
- Not prompt-injection defense — that stays the transcript sanitizer's job.
- **Text bodies only in v1.** The verifier is a text model, so it checks message/reply text,
  edit content, and thread names — NOT uploaded file/image bytes (`sendWithFiles` moderates the
  caption, not the attachment) or inbound media. Attachment moderation is a later, different job.
- **Inbound Discord samples the TRIGGER, not the whole run context.** The `ChannelDispatcher`
  coalesces rapid messages per channel and a run then reads recent channel history, so a message
  sent seconds before a benign trigger (or plain channel chatter the run later ingests) isn't
  individually checked. The **outbound** verifier is the real backstop on what Baxter actually
  *says* (it moderates every reply regardless of what's in context); inbound is a first-line
  filter on the message that drives a run. Per-message moderation of all channel traffic is a
  heavier, higher-call-volume follow-up an operator can opt into, not v1. (Email is 1 thread =
  1 run, and checks the trigger message's own text, so it has no coalesce analog.)
- **Voice is out of scope for v1** (inbound transcripts and TTS output are unmoderated). Note that
  voice-dispatch runs that reply via `discord-cli` still inherit the outbound hook for free; only
  the transcript-in and spoken-out paths are uncovered.
- The policy prompt is a sensible default, overridable via env so the operator can tune what
  counts as objectionable without a code change.
- Self-harm/crisis content is out of scope for a nuanced response in v1 — it blocks like any
  other category with a gentle canned line; a tailored supportive flow can come later.

## Testing

Against a **fake verifier** (injected, no network) + env toggles: disabled → allow (no call);
verdict parsing (ALLOW / BLOCK category / unknown category → other / unparseable → allow);
fail-open on a thrown/timed-out call + the alert; category → canned-reply mapping; and each hook
gating a spawn/send with a mocked `moderate`. Matches the existing bar (pure cores unit-tested,
network injected).
