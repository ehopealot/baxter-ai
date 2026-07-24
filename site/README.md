# `site/`: the project landing page

A static page describing Baxter, for people arriving at the repo. No build step and
no dependencies: `index.html`, `styles.css`, `app.js`, a `404.html` that reuses the
same stylesheet, and `og.png` for link previews. Fonts come from Google Fonts;
everything else is local.

`app.js` is entirely progressive enhancement. It staggers the reveal of the hero
conversation, marks the nav link for the section you're reading, and injects the
copy buttons on the code blocks. With JS off you get the finished conversation,
four working anchors, and selectable code, so nothing on the page depends on it.

`og.png` is generated, not drawn: `site/README` has no build step, but the card was
rendered from the page's own tokens and fonts at 1200x630. Re-render it the same way
if the headline or palette changes, so the preview doesn't drift from the page.

## Look at it

```bash
python3 -m http.server 8000 --directory site   # then open http://localhost:8000
```

Opening `site/index.html` directly in a browser works too.

## Publish it

Any static host serves this directory as-is.

On **GitHub Pages**, go to *Settings → Pages* and set the source to **GitHub
Actions**. `.github/workflows/pages.yml` then uploads this directory on every push
to `main`. (Pages' simpler "deploy from a branch" mode only publishes the repo root
or `/docs`, which is why the workflow exists rather than a settings toggle.)

The workflow does nothing until you pick that source, and it only ever reads
`site/`. It builds nothing and touches no other part of the repo.

## Keep it honest

The copy makes specific claims about what Baxter does and what the security section
promises. Both were taken from `README.md` and `app/CLAUDE.md`. When a surface, a
tool, or a limit changes there, change it here too.

The security section is written for a reader, not an engineer, but every line maps
to something enforced in code: the credential boundary and cwd-confinement from
`app/CLAUDE.md`'s Auth section, `network: none` from the codapi sandbox, the DM gate
and per-channel run budget from the Discord bot, and the recurrence/task/fire caps
from the heartbeat scheduler. Keep that mapping true. The section's whole claim is
that these aren't prompt text.

Two things in `index.html` hardcode the deployed address: `og:url` and `og:image`
have to be absolute, because most link scrapers won't resolve a relative image.
They currently point at the default GitHub Pages URL. If the site moves to a custom
domain, change both.
