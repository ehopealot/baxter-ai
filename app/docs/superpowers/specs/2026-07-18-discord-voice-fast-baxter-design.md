# Discord voice — "Fast Baxter" (a greeter in front of the real agent)

**Date:** 2026-07-18
**Status:** design, pending review — **not** started (a plumbing spike gates the build)
**Surface:** Discord voice (new daemon); reuses the existing text Baxter for real work

## Problem / goal

Have a spoken, real-time voice conversation with Baxter in a Discord voice
channel. The existing bot is **spawn-per-message** (a scoped run boots, loops
tools for seconds, posts, exits) — far too slow and stateless for fluid
turn-taking. So voice is a **new long-lived daemon**, and the latency is solved
by splitting the agent in two.

## The design: front-of-house / back-of-house

**Fast Baxter** (cheap, low-latency) sits in the voice channel and, per turn,
does exactly one of:
- **Knows it cold** → answers out loud immediately (chit-chat, quick facts).
- **Needs the real work** → calls its **one tool, `dispatch_to_baxter(task)`**,
  says a quick ack aloud (*"on it"*), and the **real text Baxter** runs in
  parallel (full tools/memory/skills), posts to the linked text channel as
  today, and — when done — Fast Baxter **speaks a short summary back**.

Fast Baxter never blocks on a tool loop: it speaks from its own head or
fires-and-acks. That's what keeps voice real-time while the real agent is
untouched. The single dispatch tool is the entire bridge.

## Decisions (locked with the operator)

- **Name:** "Fast Baxter" (the voice/greeter layer); "real Baxter" = the existing
  text daemon.
- **Join:** **auto-join a designated voice channel** — Fast Baxter is present
  whenever someone's in that channel; leaves when it empties (idle-cost guard).
- **Dispatched-result delivery:** real Baxter posts the full answer to text **and**
  Fast Baxter **reads a short spoken summary back** when the async run finishes
  (needs a completion callback + a speech queue so read-backs don't collide with
  live conversation).
- **Stack: strongly in-family / self-hosted.** minimax/openrouter for the brain,
  self-hosted or minimax speech; no off-family realtime API.

## Architecture

A new **`voice-bot.mjs`** daemon (4th surface beside discord/heartbeat/gmail;
same image, config volume, network). Holds the voice connection and token like
`discord-bot.mjs`; the reasoning never touches the connection.

Real-time loop per speaking user:
1. **Receive** — `@discordjs/voice` receiver → per-user **Opus** stream → decode
   to PCM (48k stereo → 16k mono).
2. **Turn detection** — silence-based VAD: accumulate speech; on ~800 ms silence,
   finalize the utterance.
3. **STT** — the utterance → text.
4. **Fast Baxter brain** — text + a short rolling transcript → a fast model with
   ONE tool. It either emits spoken text or a `dispatch_to_baxter(task)` call.
5. **TTS + play** — spoken text → PCM → Opus → `AudioPlayer` into the connection.

**Dispatch + read-back:**
- On `dispatch_to_baxter(task)`, the daemon spawns a **real-Baxter run**
  (`runAgent` + `DISCORD_TOOLS`, cwd/skills as usual) aimed at the voice
  channel's **linked text channel** — *asynchronously* (not awaited in the voice
  turn). Fast Baxter immediately speaks an ack.
- Real Baxter posts its full answer to text (as today). On completion, its result
  is run once more through the Fast Baxter brain — "summarize this to say aloud in
  one sentence" — and the summary is **queued** for TTS so it doesn't step on live
  conversation.
- Reuse the existing per-channel run **budget/caps** on the linked text channel so
  a voice-dispatched run is bounded exactly like a typed one.

**Barge-in** (nice-to-have): if the user starts speaking while Fast Baxter is
talking, stop playback. Flagged; may defer to a follow-up.

## In-family stack (+ what to verify)

| Stage | Baseline (definitely self-hostable) | Preferred if it pans out |
|---|---|---|
| STT | **whisper.cpp** on-box (arm64 build) | MiniMax ASR API, if cleanly reachable |
| Brain | **minimax m2.7** via openrouter (already configured) — job is tiny (answer or dispatch) | a small **local Ollama** model for lower latency |
| TTS | **Piper** on-box (fast, arm64-friendly, a bit robotic) | **MiniMax TTS**, if the speech API is reachable in-family |

**Verification items before/early in the build:** (1) what MiniMax exposes for
ASR/TTS via API vs. the self-hosted fallbacks; (2) the **arm64/Colima native-dep
story** for `@discordjs/voice` (opus `@discordjs/opus` vs `opusscript`, an
encryption lib `sodium-native`/`libsodium`, and `ffmpeg`) — the same class of
build pain as codapi/Piston, and the single biggest risk.

## Security / cost

- Voice daemon holds the connection + token (like `discord-bot.mjs`); the Fast
  Baxter brain runs through the **structured-tool harness with ONE tool** — no
  shell, no CLIs. Its only powers are *speak* and *dispatch to real Baxter*, and
  a dispatched task lands in real Baxter's existing guarded run. So a person in
  the voice channel has the same effective surface as someone typing at Baxter —
  bounded by the same allowlist + per-channel budget.
- **Cost:** continuous STT while occupied is the standing cost; only transcribe on
  detected speech, and **leave when the channel empties** (the auto-join guard).
  TTS cost is per utterance. Consider a per-session time/utterance cap.

## Phased plan (spike-gated)

0. **Plumbing spike** — on the arm64 image, get `@discordjs/voice` to join a
   channel and play a test tone, and receive+decode a user's Opus to PCM. Prove
   the native deps before anything else. If this fights hard, revisit.
1. **Speak path** — Fast Baxter TTS's a fixed phrase / a typed line into the VC
   (TTS + play, no STT yet). A real, testable milestone.
2. **Ears** — whisper.cpp STT + VAD turn detection → text logged.
3. **Brain + dispatch** — the one-tool fast model; `dispatch_to_baxter` spawns a
   real-Baxter run on the linked text channel; ack spoken.
4. **Read-back** — completion callback → summary → queued TTS; barge-in if time.

## Out of scope / follow-ups

- Multi-speaker diarization beyond per-user streams; music/soundboard.
- Voice on email/heartbeat surfaces.
- Off-family realtime speech-to-speech (deliberately excluded per the in-family
  decision; revisit only if the pipeline latency proves unacceptable).
