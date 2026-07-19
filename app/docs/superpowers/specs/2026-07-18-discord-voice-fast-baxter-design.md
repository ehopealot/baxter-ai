# Discord voice — "Fast Baxter" (a greeter in front of the real agent)

**Date:** 2026-07-18
**Status (2026-07-19):** phase 1 DONE + **live-tested 2026-07-18** (he joins "baxter
chat" and greets aloud — confirmed by the operator). Phase 2 (ears) DONE + **live-verified 2026-07-19** (whisper.cpp STT, pinned v1.9.1;
the daemon receive→transcribe pipeline transcribed two spoken utterances accurately
in "baxter chat", log-only for now). Voice is also configurable
(3 baked Piper voices + `VOICE_NAME`/`VOICE_LENGTH_SCALE`). Phase 3 (fast brain +
`dispatch_to_baxter`) BUILT (live speak→answer / speak→dispatch→post test still
open); phase 4 (spoken read-back) not started.
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
- **Bounding a voice-dispatched run (cross-process caveat):** the Dispatcher's
  hourly run budget and per-channel serialization are **in-memory per-process**
  (`this.runStarts` Map + concurrency/serialization maps in `discord-bot.mjs`), so
  a separate `voice-bot.mjs` gets its **own** instance — it does NOT share the text
  daemon's counters. Consequence if left as-is: the linked channel can see up to
  2× `MAX_RUNS_PER_CHANNEL_PER_HOUR` in *message-triggered* runs (voice budget +
  text budget) — on top of the text daemon's **reaction** dispatcher, which
  already carries its own same-sized per-channel budget (so the strict worst-case
  exposure is 3×) — and a voice-dispatched run can run concurrently with a typed
  one on the same channel.
  The daily **send** cap is file-based (`send-state.mjs`) and IS shared, so that
  hard stop always holds. Stance for the build: give the voice daemon its own
  Dispatcher with its **own (lower) hourly cap**; if strict shared bounding turns
  out to matter, move the run-budget accounting to shared file state under the
  config volume (like the send counter) — decided at Phase 3, not assumed here.

**Barge-in** (nice-to-have): if the user starts speaking while Fast Baxter is
talking, stop playback. Flagged; may defer to a follow-up.

## In-family stack (+ what to verify)

| Stage | Baseline (definitely self-hostable) | Preferred if it pans out |
|---|---|---|
| STT | **whisper.cpp** on-box (arm64 build) | MiniMax ASR API, if cleanly reachable |
| Brain | **minimax m2.7** via openrouter (already configured) — job is tiny (answer or dispatch) | a small **local Ollama** model for lower latency |
| TTS | **Piper** on-box (fast, arm64-friendly, a bit robotic) | **MiniMax TTS**, if the speech API is reachable in-family |

**Verification items:** (1) what MiniMax exposes for ASR/TTS via API vs. the
self-hosted fallbacks — still open.

(2) The **arm64 native-dep story for `@discordjs/voice`** — **RESOLVED by a spike
(2026-07-18) on this aarch64 / node 22 host: no native compilation needed.**
`generateDependencyReport()` on the assembled stack:
- `@discordjs/voice` 0.19.2 + `opusscript` 0.0.8 (pure-JS Opus — enough for one
  stream; native `@discordjs/opus` is a later CPU optimization needing
  `build-essential` + `libopus-dev`, not required to ship).
- **Encryption: node's built-in `aes-256-gcm` is supported** (a valid Discord
  voice mode), so a sodium lib may be unnecessary; `libsodium-wrappers` (wasm, no
  build) is the fallback for xchacha20poly1305.
- **DAVE:** modern `@discordjs/voice` hard-requires `@snazzah/davey` (Discord's
  E2EE voice). It ships a working **arm64 prebuild** (`@snazzah/davey-linux-arm64-gnu`
  0.1.12) — but the npm optional-deps bug can skip it, throwing "Cannot find
  native binding" at `require`. Ensure it installs (explicit dep, or a clean
  `npm install`); the Dockerfile step must verify the binding loads.
- **ffmpeg:** the one missing piece (TTS transcode / resampling) — a plain
  `apt install ffmpeg`, not a build.
So the codapi/Piston-class arm64 pain does **not** block voice; the image adds npm
deps + `ffmpeg` + a davey-binding install check, no toolchain.

## Security / cost

- Voice daemon holds the connection + token (like `discord-bot.mjs`); the Fast
  Baxter brain runs through the **structured-tool harness with ONE tool** — no
  shell, no CLIs. Its only powers are *speak* and *dispatch to real Baxter*, and
  a dispatched task lands in real Baxter's existing guarded run. So a person in
  the voice channel has close to the same effective surface as someone typing at
  Baxter — the same **tool allowlist** and the shared file-based **daily send
  cap**. The one gap (see the dispatch caveat above): the hourly **run budget**
  and per-channel serialization are in-memory per-process, so until that's moved
  to shared state, voice adds a second independent budget rather than sharing the
  text daemon's.
- **Cost:** continuous STT while occupied is the standing cost; only transcribe on
  detected speech, and **leave when the channel empties** (the auto-join guard).
  TTS cost is per utterance. Consider a per-session time/utterance cap.

## Phased plan (spike-gated)

0. **Plumbing spike** — **DONE**: native-dep half via the arm64 spike (Verification
   item 2, no compilation), and the live half too — join+play verified with phase 1
   (2026-07-18), receive+decode with phase 2 (2026-07-19).
1. **Speak path** — **DONE**, **live-tested 2026-07-18** (`voice-bot.mjs`,
   `make voice`, off by default): auto-join/leave on human presence + a greeting via
   a serialized Piper→ffmpeg→Opus queue, with Disconnected recovery; joins "baxter
   chat" and greets aloud. Image carries Piper (arch-selected) + the voice deps;
   pure helpers unit-tested.
2. **Ears** — **DONE** (`VOICE_LISTEN`, default on): per-speaker Opus capture →
   `AfterSilence` turn detection → prism/opusscript decode → ffmpeg 16k mono WAV →
   whisper.cpp (`transcribe()`) → logs `voice: heard <id>: ...`. whisper baked in
   the image via a multi-stage builder (no toolchain shipped; `GGML_NATIVE=OFF`
   fixes the aarch64 FP16 build). Bots skipped, `VOICE_MAX_UTTERANCE_MS` cap
   (default 60s), filler filtered. **LIVE-VERIFIED 2026-07-19**: two utterances
   ("Hey Baxter, how are you?" / "What time is it?") transcribed accurately ~1–2s
   after end-of-speech, second not dropped (slot-release fix holds).
3. **Brain + dispatch** — **BUILT** (`voice-brain.mjs` + wiring): a transcript →
   one OpenRouter chat/completions call (default `minimax-m2.7`, `AbortSignal`
   timeout) with a single `dispatch_to_baxter` tool → either a short spoken answer
   (Piper) or a spoken ack + `dispatchToBaxter()` spawning the full text Baxter
   (`runAgent`/`DISCORD_TOOLS`) to post to the linked text channel. Rolling context
   (`VOICE_BRAIN_CONTEXT_TURNS`), brain serialized on a promise chain, empty-task
   guard, task length-capped. Gated by `OPENROUTER_API_KEY` (no key = ears-only).
   **Open:** the live speak→answer and speak→dispatch→post test (redeploy + operator).
   Original sketch: the one-tool fast model; `dispatch_to_baxter` spawns a
   real-Baxter run on the linked text channel; ack spoken.
4. **Read-back** — completion callback → summary → queued TTS; barge-in if time.

## Out of scope / follow-ups

- Multi-speaker diarization beyond per-user streams; music/soundboard.
- Voice on email/heartbeat surfaces.
- Off-family realtime speech-to-speech (deliberately excluded per the in-family
  decision; revisit only if the pipeline latency proves unacceptable).
