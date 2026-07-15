# Baxter Sandbox Artifacts + Discord Attachments — Design Spec

**Date:** 2026-07-15
**Status:** Approved design, pending implementation plan
**Component:** `app/` (the "Baxter Burgundy" agent) — extends the codapi code sandbox

## Goal

Let Baxter **generate media files** (charts, images, PDFs, audio) in the offline codapi sandbox and **share them** — starting with **Discord attachments**. Today the sandbox can only return ≤8 KB of text (stdout), so a file it creates is destroyed with the ephemeral container. This adds a path for binary **artifacts** to come back out of the sandbox into Baxter's workspace, and a `--file` upload path on `discord-cli`.

## Non-goals

- **Email attachments** — a deliberate fast-follow (a separate small spec adding MIME attachments to `gmail.mjs`). This spec is Discord-only on the send side.
- **Large media / video** — the artifact channel is size-capped (8 MB/artifact). Video, or anything needing a multi-MB+ pipe, is out of scope; if it ever matters, that's the writable-mount design (Approach B below), deliberately deferred.
- **Node media libraries** — the artifact *mechanism* is language-agnostic (works for `code-cli node` too), but the curated media libs are Python-only in v1 (Node keeps lodash/dayjs).
- **No change to the sandbox's isolation posture** — it stays offline, ephemeral, read-only, non-root. The artifact channel is the *existing* stdout, just framed.

## Approach — base64 over stdout, with a random boundary

The sandbox's only egress is stdout (codapi returns it in the `/v1/exec` JSON), and the container is ephemeral, so a file written inside vanishes. The standard technique for pushing binary through a text-only channel is **base64** — this is exactly what MIME email attachments, data URIs, JSON APIs, and Jupyter kernels (returning `matplotlib` images to the notebook frontend) do. Given codapi's stdout-only, ephemeral model, it's the idiomatic fit.

**Considered and rejected:** a **writable artifact mount** (Approach B) — no size cap, but codapi's config supports only the one read-only code mount, so it needs custom runner work or fights a cleanup race, *and* it widens the isolation surface (a writable channel out). Not worth it for a capability (huge files) v1 doesn't need. **Raw base64 with a fixed marker** (Approach C) — rejected because a fixed delimiter is forgeable: a program that prints the marker string could inject a fake artifact frame.

**The framing is the delicate part**, and it's solved the same way the transcript-forgery pipeline solved the trigger marker: the **trusted side mints a random, unguessable boundary**. `code-cli` generates a per-run random boundary (a nonce) and hands it to the sandbox; the wrapper frames artifacts with it; the running (attacker-influenceable) program can't forge a delimiter it can't guess — exactly the MIME-multipart-boundary trick, and consistent with `gmail.mjs`'s random UUID placeholder for `[^ RESPOND TO THIS MESSAGE]`.

## Architecture

### Data flow

```
Baxter's code:  plt.savefig("/tmp/artifacts/chart.png")      # save to the known dir
      │
code-cli    →  mints a random boundary B, sends /v1/exec with the program
               PLUS an extra file carrying B (the trusted side owns the nonce)
      │
codapi run  →  wrapper (the sandbox's run command) runs the program, then for
               each file in /tmp/artifacts emits, framed by B:
                 <B> ARTIFACT <name> <byte-size>
                 <base64…>
                 <B> END
               (oversized files -> `<B> TOOBIG <name> <size>` instead of bytes)
      │
code-cli    →  splits program stdout from artifact frames using B (which it
               minted, so the program can't forge it), base64-decodes each,
               sanitizes the name, verifies decoded size == declared size, and
               writes the file into  <workspace>/artifacts/<name>. Prints the
               program's real stdout plus a summary: "wrote artifacts/chart.png
               (142 KB)".
      │
Baxter      →  discord-cli reply <ch> <msg> --file artifacts/chart.png
```

### Sandbox images & the wrapper
- **Python image** (`app/sandboxes/python/Dockerfile`) gains **Pillow**, **matplotlib** (configured for the headless **Agg** backend), and **reportlab** (PDF/documents). Audio needs nothing new — Python's stdlib `wave` + numpy. Installed offline at build, like the existing libs.
- **A wrapper** becomes the sandbox `run` command (both python and node, via `commands.json`): it creates `/tmp/artifacts`, runs the user program (preserving its exit status and stdout/stderr verbatim), then reads the boundary the trusted side supplied and emits each artifact framed by it. Enforces the **per-artifact size ceiling** (emits a `TOOBIG` frame instead of bytes for oversized files) so it can never produce base64 that would overflow `noutput` and be truncated into a corrupt file. Baked into the images (a small script), not inline in `commands.json`, so it's testable and readable.
- **The boundary hand-off:** `code-cli` includes the nonce as an **extra file** in the `/v1/exec` `files` map (codapi writes every file in the map into the run dir); the wrapper reads it. (Implementation verifies codapi delivers extra files; fallback if not: the wrapper generates the boundary and prints it as its first stdout line — still unforgeable by the user program, which never sees it, though the trusted-side-mints framing is preferred for consistency with the codebase.)

### `codapi.json`
- Raise `noutput` from 8 KB to comfortably above the artifact ceiling (**8 MB/artifact**; `noutput` ~12 MB), so a run's framed base64 is never truncated. Still well under Discord's 25 MB. All other box limits (offline, non-root, read-only, cap-drop, memory, pids, timeout) unchanged. (Memory: the box `memory` limit may need a bump to hold an 8 MB artifact + base64 in the encode step — sized in the plan.)

### `code-cli`
- Mint a random boundary, include it as the extra file, POST as today.
- Parse the response stdout: everything outside the frames is the program's own output (shown to Baxter as now); each frame is decoded, its **name sanitized** (basename only; reject `..`, absolute, empty, or names resolving outside the artifacts dir), its **decoded size checked against the declared size** (mismatch → error, nothing written), and written to `<workspace>/artifacts/<name>`.
- Report a clear summary of written artifacts (path + human size) and of any `TOOBIG` frames.
- Pure helpers (frame parsing, name sanitization, size formatting) are unit-tested; the fetch/dispatch stays entry-guarded as today.

### `discord-cli`
- `send`, `reply`, and `send-thread` gain **`--file <path>`** (repeatable for multiple attachments): resolve the path against Baxter's workspace, read the bytes, and do a **multipart/form-data** POST (`payload_json` + `files[n]`) to the Discord API. A missing/unreadable path or one exceeding Discord's size limit is a clear error with no send. The existing daily send-cap still counts one logical send. The pure multipart-body builder is unit-tested.

### Prompts, skills, docs
- The `code` skill and both prompts document the loop: *save media to `/tmp/artifacts/…` in your code → `code-cli` returns it to `artifacts/…` in your workspace → attach with `discord-cli … --file artifacts/…`*. The `discord` skill documents `--file`. `app/CLAUDE.md` gets an "Artifacts" note under the code-execution section (the framing/security model).

## Security posture

- **Unforgeable framing** — the random per-run boundary is minted by the trusted `code-cli`, so an attacker-influenced program can't inject a fake artifact frame. Same threat model and fix as the transcript-forgery trigger marker.
- **Filename sanitization** — artifact names originate inside the sandbox (attacker-influenceable). `code-cli` takes the **basename only**, rejects `..`/absolute/empty, and writes **only** into the workspace `artifacts/` dir — a crafted `../../…` can never escape. (This is the load-bearing check; mirrors the project's "attacker-influenced text needs sanitizing at the trust boundary" principle.)
- **Size caps, enforced twice** — the wrapper refuses to emit oversized artifacts (`TOOBIG`), and `code-cli` independently guards, with `noutput` sized above the ceiling so base64 is never truncated into a corrupt file. Bounds memory and prevents truncation-corruption.
- **Integrity** — decoded size must equal the declared size, or `code-cli` errors rather than writing a partial file.
- **Isolation unchanged** — no new mount, no network; the sandbox stays offline/ephemeral/read-only/non-root. The only egress remains stdout.
- **Discord upload** — the `--file` path is Baxter's own workspace file (his to send); guarded only for existence and Discord's size limit.

## Components / files

**Modified:**
- `app/sandboxes/python/Dockerfile` — add Pillow, matplotlib (Agg), reportlab.
- `app/sandboxes/python/`, `app/sandboxes/node/` — the artifact-emit wrapper script (baked in).
- `app/codapi/sandboxes/python/commands.json`, `.../node/commands.json` — run via the wrapper.
- `app/codapi/codapi.json` — raise `noutput` (and `memory` if needed).
- `app/scripts/code-cli.mjs` (+`.test.mjs`) — boundary mint, frame parse/decode, name sanitization, size/integrity guards, artifact write + summary.
- `app/scripts/discord-cli.mjs` (+`.test.mjs`) — `--file` multipart upload on send/reply/send-thread.
- `app/prompt.md`, `app/discord-prompt.md`, `app/skills/code/SKILL.md`, `app/skills/discord/SKILL.md`, `app/CLAUDE.md` — document the loop.

**Created:**
- The wrapper script (e.g. `app/sandboxes/emit-artifacts.sh` or per-image), if not inlined.

## Testing

- **Unit (`node:test`):** `code-cli` frame parser (well-formed, no-artifacts, `TOOBIG`, size-mismatch, a program that prints the boundary-looking text but *not* the real nonce → not misparsed), name sanitizer (`..`, absolute, empty, normal), size formatter; `discord-cli` multipart builder + path/size guards.
- **Integration (codapi up):** round-trip a **matplotlib** chart (PNG), a **Pillow** image, a **WAV** (stdlib), and a **reportlab** PDF out to the workspace; an oversized artifact → `TOOBIG` reported, nothing written; a crafted `../escape.png` name → sanitized.
- **End-to-end:** a Discord message asking Baxter to plot something; confirm he generates it via `code-cli`, it lands in `artifacts/`, and he posts it with `discord-cli --file`.

## Acceptance criteria

1. Baxter's sandbox code can save a chart/image/PDF/WAV to `/tmp/artifacts/`, and `code-cli` returns the real file into `<workspace>/artifacts/`, reporting path + size.
2. Framing uses a random `code-cli`-minted boundary; a program that prints marker-looking text cannot forge an artifact.
3. Filenames are sanitized to the artifacts dir (no traversal); oversized artifacts are refused cleanly; decoded size is integrity-checked.
4. `discord-cli send|reply|send-thread --file <path>` uploads the file as a Discord attachment; missing/oversized paths error without sending; the daily send-cap still applies.
5. The sandbox's offline/ephemeral/read-only/non-root isolation is unchanged (no new mount, no network).
6. Prompts and the `code`/`discord` skills document the save→return→attach loop; the email side and existing code paths are otherwise unchanged.
