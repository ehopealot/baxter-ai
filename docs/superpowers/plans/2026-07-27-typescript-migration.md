# TypeScript Migration Plan

> **For agentic workers:** executed via superpowers:subagent-driven-development — a fresh
> typing agent per cluster, controller (me) drives all commits + the per-commit fable
> reviewer (`.claude/reviews/<hash>.md`). Steps use checkbox (`- [ ]`) tracking.

**Goal:** Convert the `app/` agent source (95 `.mjs` files, ~16k LOC) to TypeScript with
**no build step** — Node 22 runs `.ts` directly via type-stripping.

**Architecture:** Node 22.18+ strips types at runtime (verified: `node main.ts` and
`node --test` both run `.ts` here). So the runtime model is unchanged — we rename
`.mjs`→`.ts`, point `node`/shims/Makefile at `.ts`, and add a **separate** `tsc --noEmit`
type-check gate. No emitted JS, no bundler, no Docker build stage. TS is restricted to
**erasable syntax only** (`erasableSyntaxOnly` + `verbatimModuleSyntax`) so Node can strip
it — no enums/namespaces/parameter-properties.

**Tech stack:** Node 22.23 (`node:22-slim`), ESM (`"type": "module"`), `node:test`,
`typescript` + `@types/node` as the only new devDeps.

## Global Constraints

- **Green at every commit.** `cd app && node --test` (baseline **531 pass, 0 fail**) AND
  `cd app && npx tsc --noEmit` must both pass after every task. Never commit red.
- **No build step.** The image still runs `node scripts/poll.ts`. No compile-to-JS, no
  new Docker stage. Import specifiers carry the real on-disk extension (`.ts`).
- **Erasable syntax only.** Type-only constructs only; annotations, `interface`, `type`,
  `import type`, `as`. No enums, namespaces, parameter properties, or decorators.
- **Pragmatic strict end-state.** Final tsconfig `strict: true`; `any`/`unknown` allowed
  at genuine external boundaries (SDK responses, dynamic JSON, `JSON.parse`) rather than
  fought to zero. `noImplicitAny` starts OFF (green-at-every-commit) and is turned ON in
  the final tightening task, not before.
- **Grants stay in lockstep.** `grants.ts` `MAIL_CLI`/`DISCORD_CLI` paths and the literal
  grant strings a test asserts must reference `.ts`, matching the actual spawn paths, or
  the sandbox blocks the tools.
- **One agent per cluster; renames never happen in typing tasks.** All renames occur once,
  in Task 0. Typing tasks only add annotations *within* files → disjoint file sets are
  collision-free.

---

## Task 0 — Mechanical rename + tooling (controller does this directly)

The load-bearing foundation; done by hand, not delegated. One commit, must stay green.

**Files:** every `app/**/*.mjs` (excl `node_modules`) → `.ts`; new `app/tsconfig.json`;
`app/package.json` (+ devDeps); `app/package-lock.json`; `app/Dockerfile`; `Makefile`.

- [ ] Add `typescript` + `@types/node` to `app/package.json` devDependencies; `npm install` (intentional lockfile change).
- [ ] `git mv` all 95 source `.mjs` → `.ts` (source + tests + evals + scenarios).
- [ ] Rewrite references across the renamed tree: import specifiers `"./x.mjs"`→`"./x.ts"`
      (incl. dynamic `import()` and `new URL("./x.mjs", import.meta.url)`), and the
      functional non-import refs:
  - `evals/harness.ts` `MOCK_HANDLER` → `mock.ts`
  - `evals/run.ts` `.endsWith(".mjs")` → `.endsWith(".ts")`
  - `scripts/grants.ts:21-22` `MAIL_CLI`/`DISCORD_CLI` join → `mail.ts`/`discord-cli.ts`
  - `scripts/add-skill.ts` `GRANTS_PATH` → `grants.ts`; execFileSync `grants.test.mjs` → `grants.test.ts`
  - `evals/harness.test.ts` + any test asserting literal `/app/scripts/*.mjs` grant strings → `.ts`
  - Comment prose `foo.mjs` → `foo.ts` (bulk; keeps the tree self-consistent)
- [ ] `app/Dockerfile`: CLI-shim printfs (`exec node /app/scripts/*.mjs`) and
      `CMD ["node","scripts/poll.mjs"]` → `.ts`.
- [ ] `Makefile`: `node scripts/*.mjs`, `node evals/run.mjs`, `node app/scripts/add-skill.mjs` → `.ts`.
- [ ] Write `app/tsconfig.json` (lenient start): `module`/`moduleResolution: nodenext`,
      `allowImportingTsExtensions`, `noEmit`, `verbatimModuleSyntax`, `erasableSyntaxOnly`,
      `strict: false`, `noImplicitAny: false`, `skipLibCheck`, `types: ["node"]`,
      `include: ["scripts","evals"]`. Iterate to green.
- [ ] Gate: `cd app && node --test` = 531 pass; `cd app && npx tsc --noEmit` = 0 errors. Commit.

**Add a `make check` / `make test`** so later tasks and CI have one gate:
`check: tsc --noEmit && node --test` (run from `app/`). Fold into this task or a 0b.

---

## Typing clusters (Tasks 1–7, delegated one agent per cluster)

Each: add parameter/return/field annotations, `import type`, and `interface`/`type` for the
module's own shapes; `any`/`unknown` at external boundaries. Type the cluster's `.test.ts`
alongside its modules. Gate per task: `tsc --noEmit` + `node --test` green. Return diff to
controller → fable review → controller commits.

- **Task 1 — Foundation/leaf utils:** `paths, http-util, runtime, transcript, send-state,
  schedule-store, grants, data-sources, runner-events, runner-common` (+ tests). Most
  depended-on; do first so downstream imports resolve to typed exports. Model: sonnet.
- **Task 2 — Harnesses:** `harnesses/{claude,custom,custom-runner,local,local-runner,
  openrouter,openrouter-runner,openrouter-tools}` + `harnesses/dialects/{anthropic,gemini,
  index}` (+ tests). Model: sonnet (SDK/stream types).
- **Task 3 — CLIs:** `code-cli, data-cli, discord-cli, files-cli, projects-cli, schedule-cli,
  skills-cli, web-cli, add-skill, make-inbox` (+ tests). Model: haiku (mechanical argv/IO).
- **Task 4 — Surfaces/daemons:** `discord-bot, heartbeat, mail, poll, log-shipper` (+ tests).
  Model: sonnet.
- **Task 5 — TUI:** `tui, tui-core` (+ tests). Model: sonnet.
- **Task 6 — Voice:** `voice-bot, voice-brain` (+ tests). Model: sonnet.
- **Task 7 — Evals:** `evals/{assertions,harness,mock,run}` + `scenarios/*` (+ tests).
  Model: haiku.

---

## Task 8 — Tighten to pragmatic strict (controller)

- [ ] Flip `strict: true` + `noImplicitAny: true` in `tsconfig.json`.
- [ ] Fix the residual errors (add missing annotations / narrow `any` at boundaries).
- [ ] Gate green; commit.

## Task 9 — Docs refresh (controller / haiku)

- [ ] Update `app/CLAUDE.md`, root `CLAUDE.md`, `README.md`, and `docs/` filename refs
      `*.mjs`→`*.ts`; note the no-build-step TS model + `make check`.

## Final — whole-branch review

- [ ] superpowers:requesting-code-review on the full branch (most capable model), fix
      findings in one wave, then superpowers:finishing-a-development-branch.
