# `site/` — the project landing page

A static page describing Baxter, for people arriving at the repo. Three files, no
build step, no dependencies: `index.html`, `styles.css`, `app.js`. Fonts come from
Google Fonts; everything else is local.

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
`site/` — it builds nothing and touches no other part of the repo.

## Keep it honest

The copy makes specific claims about what the agent does and what the guardrails
enforce — they were taken from `README.md` and `app/CLAUDE.md`. When a surface, a
tool, or a limit changes there, change it here too.
