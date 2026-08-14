# Releasing Baxter

Baxter ships in **versioned releases** (semver tags `vX.Y.Z` + GitHub Releases).
`main` is the working branch; fresh installs and `baxter update` track the latest
**release**, not `main` — so unreleased work on `main` never reaches an install until
it's been cut into a release.

## Cut a release

From a clean, pushed `main`:

```bash
make release VERSION=v0.1.1
```

That validates the version (semver), refuses unless the tree is clean and `main` is in
sync with `origin/main`, then creates a **signed** annotated tag (`git tag -s`) and
pushes it. Pushing the tag fires **`.github/workflows/release.yml`**, which creates the
GitHub Release with auto-generated notes (diffed against the previous tag). A tag with a
hyphen (`v0.2.0-rc1`) is published as a **pre-release**, so it never becomes
`/releases/latest`.

> **Signing is a prerequisite.** `git tag -s` needs a signing key configured on your
> machine, or `make release` stops at the tag step. It's a one-time setup (SSH — reusing
> your push key — or GPG); the exact commands live in the comment above the `release`
> target in the `Makefile`. Add the public key to GitHub as a *signing* key for the
> "Verified" badge.

Nothing else is needed — no manual `gh release create`.

Versioning: bump **patch** for fixes, **minor** for features, **major** for breaking
operator-facing changes (env vars, CLI, surfaces). Pre-1.0, minor versions may still
break things.

## How installs pick up a release

- **Fresh install** (the `curl | bash` bootstrap served at bax.bot — in the **site
  repo**, not this one) resolves the latest release tag and checks it out after
  cloning, e.g.:
  ```sh
  TAG=$(curl -fsSL https://api.github.com/repos/ehopealot/baxter-ai/releases/latest \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
  git clone https://github.com/ehopealot/baxter-ai.git "$dir"
  git -C "$dir" checkout "${TAG:-main}"   # fall back to main only if no release yet
  ```
- **Existing install** — `baxter update` fetches tags, checks out the highest stable
  `v*` tag (detached HEAD), and rebuilds/restarts. `baxter update main` returns to
  bleeding-edge `main` for a dev box.

## Rolling back

Deploy an older release on the box by checking out its tag and restarting:

```bash
git checkout v0.1.0 && make run    # (+ make voice if you run voice)
```
