# Voice "muzak" — hold music while Baxter works

**Date:** 2026-07-19
**Status:** approved (operator: duck under speech, play only while working, ON by default, public-domain audio)

## Goal

When Fast Baxter dispatches a voice request to the full text Baxter (a run that
takes seconds), play soft background music in the voice channel for the duration,
so the call isn't dead air while he works. The music **ducks** (goes silent) while
anyone is speaking — Baxter's spoken read-back most importantly — and stops once
the work is done.

## Key decisions (operator)

- **Duck under speech**, don't mix under it. Discord plays one audio source per
  connection, so true "quieter-under-voice" needs a PCM mixer; a hard duck (pause
  the music while speech plays, resume after) is the pragmatic, low-CPU realization
  and is what "duck and just play while he's working" asks for.
- **Play only while a dispatch is in flight** — starts when a dispatch begins,
  stops when the last concurrent dispatch finishes (keyed off `inflightDispatches`).
- **ON by default** (`VOICE_MUZAK=1`), with a kill switch.
- **Public-domain audio, a random track each time.** A pool of ~30 public-domain
  tracks (the archive.org `FREE_background_music_dhalius` collection) is baked into
  the image at build time and one is picked at random each time music plays. A
  gentle ambient loop synthesized at build with ffmpeg remains as the fallback if
  the collection download fails. Overridable: `VOICE_MUZAK_DIR` (a folder to draw
  the random pool from) or `VOICE_MUZAK_FILE` (pin a single file).

## Architecture

Two audio players on the one voice connection, so the delicate speech state machine
is untouched:

- **speechPlayer** — the existing player + `SpeechQueue` (TTS). Unchanged except it
  gains an optional `ducker` with `duck()`/`unduck()` hooks called around each
  utterance.
- **musicPlayer** — a second `AudioPlayer` created with
  `NoSubscriberBehavior.Pause`, playing the muzak loop.

**Ducking = subscription swap.** A `VoiceConnection` plays whichever player it's
subscribed to. The `Muzak` coordinator owns the subscription:
- while working and not speaking → subscribe `musicPlayer` (music audible);
- when a TTS utterance starts (`SpeechQueue.duck()`) → subscribe `speechPlayer`,
  which leaves `musicPlayer` with no subscriber → it goes **AutoPaused** (holds
  position);
- when the utterance ends (`unduck()`) and still working → re-subscribe
  `musicPlayer` → AutoPaused **auto-resumes** from where it paused.

**Looping** is a `musicPlayer` `Idle` handler that replays the loop resource while
active (Idle only fires while subscribed+playing; an AutoPaused player never goes
Idle, so a ducked loop doesn't restart).

**Lifecycle** (`dispatchToBaxter`): `muzak.start()` right after `inflightDispatches++`;
`muzak.stop()` in the run's `.finally` when `inflightDispatches === 0` (last one
out). Concurrent dispatches share one music session.

**Volume:** the loop resource uses `inlineVolume` at `VOICE_MUZAK_VOLUME` (default
low, ~0.15) so it's a subtle bed, not a distraction.

## Failure isolation

Muzak must never break the working speech path: setup is wrapped so any failure
falls back to `muzak = null` (today's speech-only behavior), and every music
operation is best-effort. Worst case is "no music" or "music didn't resume" —
never a crash or lost read-back.

## Knobs

- `VOICE_MUZAK` (default 1) — on/off.
- `VOICE_MUZAK_FILE` (default the baked `/opt/muzak/loop.ogg`) — override track.
- `VOICE_MUZAK_VOLUME` (default 0.15) — 0..1 inline volume.

## Testing

The live audio path isn't unit-tested (needs a real connection), but the `Muzak`
coordinator's **state logic** is, with fake players/connection: start→subscribes
music, duck→subscribes speech (music AutoPauses), unduck→back to music, stop→
speech + music stopped, and start()/duck() as no-ops when disabled. A build-time
check confirms the ffmpeg loop asset is produced. Then a live before/after in the
channel.
