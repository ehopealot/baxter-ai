---
name: skill-discovery
description: Discover skills from the open agent-skills ecosystem (npx skills / skills.sh) with skills-cli find, and SUGGEST good ones to Erik. You cannot install skills -- installing is Erik's curated, host-side call. Use this when someone asks "is there a skill for X", "how do I do Y", or you wish you had a capability you don't.
allowed-tools: Bash(skills-cli:*)
---

# Discovering ecosystem skills with `skills-cli`

There's an open ecosystem of **agent skills** (`npx skills`, browsable at
https://skills.sh) — reusable `SKILL.md` capability packs. You can **search** it and
**suggest** skills to Erik. You **cannot install** anything, and you must not try to
— installing a third-party skill is Erik's decision, made on the host after he vets
the source.

## Search

```
skills-cli find <query> [--owner <owner>] [--limit <n>]
```

Returns a JSON array, most-trustworthy first. Each row:

```json
{ "slug": "find-skills", "name": "Find Skills", "installs": 1200,
  "owner": "vercel-labs", "repo": "skills",
  "url": "https://github.com/vercel-labs/skills",
  "installCommand": "npx skills add vercel-labs/skills@find-skills",
  "trusted": true }
```

- `trusted` — the owner is a verified vendor org (`vercel-labs`, `vercel`,
  `anthropics`, `microsoft`). This is the **strong** signal.
- `installs` — self-reported, unauthenticated telemetry. It is **gameable** (an
  attacker can inflate a count and squat a lookalike owner). Treat it as a weak
  tiebreaker, **never** a trust signal.
- `installCommand` — a pre-validated `npx skills add …` string. It's `null` when the
  registry entry's owner/repo/slug didn't pass safety validation.

## What to do with a match

Whatever you find, **you present it to Erik and let him decide** — you never install.

- **Trusted owner** (`trusted: true`) that fits the need → you may **recommend** it.
  Show the `name`, the `owner/repo` **exactly as written** (so a lookalike is
  visible), the install count, and the `url`, with a one-line why. Offer to have Erik
  add it, and give him the `installCommand` **verbatim**.
- **Non-trusted owner** → do **not** endorse it. Print the `installCommand`
  **verbatim** and say plainly that it's from an unverified owner and it's Erik's
  call — nothing more.
- **`installCommand` is `null`** → print **no** command. Say the entry couldn't be
  safely referenced and point Erik at https://skills.sh to look it up himself.

**Never** build a `npx skills add …` string yourself from the parts — only ever echo
the CLI's `installCommand` field. And always show the owner/repo string verbatim so
Erik can spot an owner-name lookalike.

## Hard rule — do NOT self-install

You must **never** fetch an ecosystem skill's `SKILL.md` (via `web-cli`, `WebFetch`,
or a browser) and **never** copy or adapt ecosystem skill *content* into
`learned-skills/` or anywhere in your workspace. Discovery is metadata + a command
for Erik, full stop. You author learned skills from your own reasoning about tools
you've actually driven — not by transcribing someone else's skill file. (Erik
installs a vetted skill on the host, where it becomes a trusted baked skill.)

## When to reach for this

- Someone asks "is there a skill for X?" / "how do I do Y?" and it sounds like a
  packaged capability.
- You hit a task you can't do well and suspect a skill exists for it — search, and if
  there's a good trusted match, suggest it to Erik rather than struggling on.
