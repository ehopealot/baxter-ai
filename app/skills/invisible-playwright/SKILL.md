---
name: invisible-playwright
description: Stealth browser automation via invisible-cli -- an anti-detect (patched Firefox) browser for sites that fingerprint or block ordinary automation (Cloudflare "Just a moment...", bot walls). Same snapshot+ref workflow as playwright-cli.
allowed-tools: Bash(invisible-cli:*)
---

# Stealth Browser Automation with invisible-cli

`invisible-cli` drives an **anti-detect browser** — a patched Firefox
(invisible_playwright) whose fingerprint (navigator, screen, GPU/WebGL,
canvas, fonts, audio, WebRTC, timezone) is masked at the engine level, so it
presents as an ordinary Windows desktop rather than automated Linux. Use it
for sites that block or challenge the normal `playwright-cli` browser:
Cloudflare "Just a moment…" interstitials, "enable JavaScript / you are a
bot" walls, or anywhere a login/booking flow fails because automation is
detected.

**For everything else, prefer `playwright-cli`** (Chromium, faster to start).
Reach for `invisible-cli` when detection is the problem.

The interaction model is identical to `playwright-cli`: open a page, take a
`snapshot` to get `[ref=eN]` handles for elements, then act on those refs.
One persistent browser session is held open by a background daemon between
commands; `close` ends it. Cookies and localStorage persist across sessions
(and container restarts) automatically, so logins carry over between emails.

## Quick start

```bash
# open the browser (optionally navigating straight to a URL)
invisible-cli open https://example.com/
# take a snapshot to see the page and get element refs
invisible-cli snapshot
# interact using refs from the snapshot
invisible-cli click e15
invisible-cli fill e5 "user@example.com"
invisible-cli press Enter
# when done
invisible-cli close
```

## Commands

### Core

```bash
invisible-cli open                 # open the browser (blank page)
invisible-cli open https://example.com/   # open and navigate right away
invisible-cli goto https://example.com/page
invisible-cli snapshot             # aria tree with [ref=eN] handles
invisible-cli find "Sign in"       # snapshot lines matching text (case-insensitive)
invisible-cli click e3
invisible-cli dblclick e7
invisible-cli fill e5 "user@example.com"   # clear + type into a field
invisible-cli type e5 "search query"        # type key-by-key into a field
invisible-cli press Enter                    # a keyboard key on the page
invisible-cli hover e4
invisible-cli select e9 "option-value"       # pick a <select> option
invisible-cli check e12
invisible-cli uncheck e12
invisible-cli eval "() => document.title"
invisible-cli eval "el => el.getAttribute('data-testid')" e5   # eval against a ref
invisible-cli screenshot                     # -> screenshot.png in the cwd
invisible-cli screenshot page.png
invisible-cli close                          # end the session (saves cookies/state)
```

### Navigation

```bash
invisible-cli go-back
invisible-cli go-forward
invisible-cli reload
```

## Element refs (how targeting works)

`snapshot` returns an accessibility tree where every interactable node is
tagged with a `[ref=eN]` handle, e.g.:

```
- link "Learn more" [ref=e6] [cursor=pointer]
- textbox "Email" [ref=e11]
- button "Sign in" [ref=e14]
```

Pass that ref (`e6`, `e11`, `e14`) as the target of `click`/`fill`/`hover`/
etc. Refs are recomputed on every snapshot, so after a navigation or a click
that changes the page, take a fresh `snapshot` before using refs again.
Every command that changes the page automatically appends the new snapshot
to its output, so you usually don't need a separate `snapshot` call after
each action. As a fallback, a target that isn't a `eN` ref is treated as a
raw Playwright selector (CSS / text), e.g. `invisible-cli click "text=Sign in"`.

## Stealth notes

- The browser already masks `navigator.webdriver`, presents a Windows
  fingerprint, and runs headed (under a hidden virtual display) rather than
  true-headless — no extra flags needed. Just use it and detection-based
  blocks should not fire.
- It uses a **fixed device fingerprint** (stable across sessions) plus a
  **persistent cookie/localStorage store**, so a site sees a consistent
  returning visitor, not a fresh bot each time.
- Human-like mouse movement/timing is on by default.
- If a Cloudflare interstitial appears, give it a moment and take another
  `snapshot`; it usually clears on its own with this browser. Don't fall
  back to `playwright-cli` for such a site — that's the browser it blocks.

## Session lifecycle

- The first `open` starts the background browser (takes ~10–20s to boot the
  patched Firefox); subsequent commands reuse it and are fast.
- The session stays alive between commands (and between separate email runs,
  as long as the container is up) until you `close` it.
- `close` saves cookies + localStorage and shuts the browser down. State is
  also saved after every page-changing command, so an unexpected restart
  won't lose logins.
- If a command ever hangs (a stuck launch or a page that never settles), the
  CLI now gives up after ~30s, tears the stuck browser down, and — for `open` —
  reopens a fresh one and retries once. If you see a "hung … it has been reset"
  message on a non-`open` command, just run `open` again to start a new session.
