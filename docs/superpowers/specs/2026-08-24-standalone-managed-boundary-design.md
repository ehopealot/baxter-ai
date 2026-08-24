# Standalone and Managed Baxter Boundary

**Status:** Approved design direction; implementation deferred
**Date:** 2026-08-24
**Repository:** `ehopealot/baxter-ai`

## Summary

`baxter-ai` remains one public repository containing a reusable agent runtime and inspectable managed-client behavior. A new explicit `BAXTER_DEPLOYMENT_MODE=standalone|managed` selects the deployment plane. Standalone is a best-effort Discord deployment; managed mode runs the Home-connected multiplexed `light` fleet using provisioning supplied by proprietary `baxter-control`. Managed client source, prompts, policies, and protocol clients remain public for inspection; the private control plane does not become self-hostable.

This specification defines configuration authority, reconciliation, commands, managed preflight, import boundaries, release, and rollout. It implements none of them.

## Goals and non-goals

1. A public checkout defaults to the standalone plane: Discord, Codapi, and local SearXNG only when `SEARXNG_LOCAL=1`.
2. Managed mode is explicit and validly provisioned before `light` starts.
3. Standalone roots do not take transitive TypeScript dependencies on managed clients.
4. Direct light scripts remain development/test seams, not supported standalone product surfaces.
5. A transition cannot silently retain an old managed fleet in standalone mode.

This work does **not** implement the private Worker, Durable Objects, browser/session APIs, tenant authority, or provisioning plane; change prompts, model behavior, authorization, or provider semantics; make light surfaces standalone products; or introduce wire versioning, unknown-authority-field behavior, or protocol hardening. Those changes need separate approval.

## Terms and capability contract

- **Standalone:** best-effort public deployment. Voice is explicit/additive.
- **Managed:** a `baxter-control`-provisioned tenant. Its absent `BAXTER_SURFACES` default is `mail,sms,heartbeat,home`; normalization retains the existing `home` => `chat` implication, so its effective light set contains all five light surfaces but not Discord. Voice is explicit/additive except `baxter up all`.
- **Light surfaces:** `home`, `chat`, `sms`, `mail`, and `heartbeat`, multiplexed through one `light` container.
- **Direct development entry point:** a script run for development, diagnostics, or focused tests; not a packaged deployment surface.

| Capability | Standalone | Managed |
|---|---|---|
| Discord text, Codapi, local runtime | Best-effort supported | Supported |
| Local SearXNG | Only when `SEARXNG_LOCAL=1` | Only when `SEARXNG_LOCAL=1` |
| Voice | Explicit/additive | Explicit/additive; included by `up all` |
| Home, Chat, SMS, packaged Mail/heartbeat | Unavailable/not promised | Selected light surfaces |
| Individual light scripts | Development/testing only | Internal light components |

## Canonical configuration resolver

One shared resolver is authoritative for `BAXTER_DEPLOYMENT_MODE` and `BAXTER_SURFACES`. Make, `bin/baxter`, systemd, status, Compose profile selection, preflight, startup diagnostics, and `light-bot` consume its one result; they must not independently parse either variable. The resolver logs only normalized mode/surfaces and fixed error categories.

### Source and syntax contract

`BASE_ENV` and `BASE_SECRETS_ENV` must contain neither setting; either assignment is `configuration-invalid`. `TENANT_ENV` is the only file authority. The resolver receives two separate caller facts: a process-environment value and a Make-command-line value. Make must pass the latter only when the setting appears in `MAKEOVERRIDES`/its invocation metadata; an exported value inherited by Make is not a command-line value.

The resolver reads UTF-8 environment files, ignoring one initial UTF-8 BOM and accepting LF or CRLF. Every nonblank line is either (a) a comment whose first non-ASCII-whitespace character is `#`, or (b) `[ASCII whitespace][export ASCII whitespace]NAME=VALUE`. `export` is optional; `NAME` is `[A-Za-z_][A-Za-z0-9_]*`; leading/trailing ASCII whitespace around the assignment syntax is ignored; `VALUE` is the remaining literal bytes after the `=` with ASCII-whitespace trim. Quotes are not syntax (thus `"managed"` is a literal invalid mode), inline comments are not syntax, and backslash escaping/interpolation is not performed. A malformed nonblank/noncomment line rejects the file. Duplicate assignments of either controlled setting in any one parsed file reject, including identical values. This grammar is the grammar Compose/systemd-facing resolved artifacts use for these controls; callers do not hand their original file directly to those consumers.

| Tenant-file value | Exported value | Make command-line value | Result |
|---|---|---|---|
| absent | absent | absent | setting default |
| present | absent | absent | tenant value |
| absent | present | absent | exported value |
| absent | absent | present | command-line value |
| absent | present | present, equal after ASCII trim | that value |
| absent | present | present, unequal | reject: source disagreement |
| present | either absent or equal | either absent or equal | tenant value |
| present | any unequal value | any value | reject: source disagreement |
| present | any value | any unequal value | reject: source disagreement |

Equality uses ASCII-whitespace trimming at both ends before semantic parsing. The table applies independently to each setting. A resolver/syntax/disagreement failure has no desired state: `baxter status` still inventories containers and prints `configuration-invalid`, but deliberately does not label them selected, unselected, or drifted.

### Semantic parsing

After trimming, mode is absent/empty => `standalone`; otherwise only exact lowercase `standalone` or `managed` is valid. Mode is intent: keys, files, and requested surfaces never infer it.

Known surface order is `discord,home,chat,sms,mail,heartbeat,voice`. An explicit list is comma-split and ASCII-trimmed per member. Empty explicit lists/members and unknown names reject; duplicates collapse to the known order. An absent list defaults to `discord` in standalone and `mail,sms,heartbeat,home` in managed. Normalization retains the existing `home` => `chat` implication, so the managed default's normalized light set is `home,chat,sms,mail,heartbeat`; it does not select Discord. Standalone requesting any light surface rejects. Managed accepts any known subset, subject to the command matrix.

The resolver emits an environment artifact containing exactly the normalized settings. Orchestration injects it explicitly into every selected Compose container and into the one-shot preflight; Compose profiles and `light` cannot see unnormalized source values.

## Desired state, reconciliation, and commands

There are two states: **configured desired surfaces** are the resolver result; **command-effective desired surfaces** are the configured result except for the sole override, managed `baxter up all`, which selects Discord, all five normalized light surfaces, and voice. Status reports both, including `command-effective=all` during that invocation only; `all` is not persisted and a later status returns the configured desired state. Therefore a narrow configured set after successful `up all` intentionally reports the additionally running Discord/light/voice services as `out-of-mode drift` relative to configuration (voice is separately marked additive).

Codapi is always selected. Search is selected exactly when `SEARXNG_LOCAL=1`. Voice is never a configured default and is retained by ordinary reconciliation unless `down` or a voice-control command removes it.

For a valid production `up`/`run`, reconciliation is ordered:

1. resolve and validate configuration and command-effective selection;
2. stop/remove **all** reconciled `discord`, `light`, and `search` containers after valid resolution, whether selected, unselected, or mode-forbidden (never Codapi; never additive voice);
3. validate every selected service, including Discord token and managed preflight;
4. run Compose only for selected services with the resolved artifact.

Thus configuration-invalid makes no changes; selected-service validation failure happens **after every reconciled container is removed** and before any selected service is created or restarted. It cannot leave an old selected, unselected, or forbidden Discord/light/search service running.

| Command | Standalone | Managed | Exact effect |
|---|---|---|---|
| `baxter up` / `make run` | resolved fleet; light request fatal | resolved configured subset/default | production reconciliation |
| `baxter up all` | fatal (`all` includes light) | effective `discord,home,chat,sms,mail,heartbeat,voice` | one invocation override; validates and starts full managed fleet; does not rewrite tenant config |
| `baxter home`, `make home` | fatal | configured normalized light set | reconcile the shared `light` container; never override it to `home` alone |
| `make heartbeat` | fatal | configured normalized light set | reconcile the shared `light` container; never override it to `heartbeat` alone |
| `make mail`, direct `node` light scripts | development seam | development/internal seam | not production composition |
| `make discord`, `make codapi`, `make searxng`, `baxter voice` | direct/additive applicable service | same | existing direct validation; no light implication |
| `baxter restart home|chat|sms|mail|heartbeat` | fatal | configured normalized light set | resolve/preflight, then reconcile/restart the shared `light` container without overriding it to one child |
| `baxter restart discord|codapi|voice` | direct restart | direct restart | applicable service only |
| `baxter restart` (no service) | production reconciliation, not Docker bulk restart | same | equivalent to `up`; therefore cannot bypass preflight |
| `baxter down` / `make stop` | usable even invalid | usable even invalid | stop/remove all fleet services, including additive voice |
| `baxter status`, `logs`, update/deploy | inventory/observe usable even invalid | same | status follows invalid-config rule; logs never require resolution; update/deploy run resolver-aware reconciliation after installation |

If voice is command-effectively selected, the command requires `VOICE=1`, builds/selects the voice image, and fails before Compose if that stack/image is unavailable. A shared-light operation uses the configured normalized light set: when light is absent it creates it only after valid managed preflight; when no light surface is configured, reconciliation removes light rather than restarting it; when selected preflight fails, light remains absent because step 2 already removed it, and it is never restarted.

### Failure-state table

| Failure with old container running | Result |
|---|---|
| Resolver invalid/disagreement; old Discord/light | unchanged; status inventories `configuration-invalid` without drift classification |
| Valid standalone, selected Discord lacks token; old light/Discord/search | all reconciled containers are removed in step 2; Discord is not recreated |
| Valid managed selection, managed preflight fails; old unselected light/Discord/search | all reconciled containers are removed in step 2; selected services are not created/restarted |
| Valid managed selection, managed preflight fails; old selected light/Discord/search | all reconciled containers, including selected services, are removed in step 2 and not recreated; zero light children start |

## Managed preflight and non-flapping lifecycle

Whenever any light child is selected, orchestration runs a one-shot preflight using the same image, mounts, and resolved environment as `light`. Failure emits one fixed privacy-safe category and aborts before Compose creates or restarts light.

`light-bot` repeats that validation solely as defense in depth for a deliberate direct Compose/container start that bypasses orchestration. Its status file is exactly `${STATE_DIR}/light-status.json`, containing exactly `{v:1,status:"starting"|"healthy"|"configuration-error"}`. It atomically writes `{v:1,status:"starting"}` (write temp file, rename) before validation, then atomically writes the terminal `{v:1,status:"configuration-error"}` on expected configuration failure or `{v:1,status:"healthy"}` on valid startup. Expected configuration failure logs one fixed diagnostic, starts zero children, keeps a ref'd idle handle, and fails healthcheck. The healthcheck treats a missing or non-`healthy` status as unhealthy. `baxter status` reads this status and distinguishes `configuration-error` from generic Docker unhealthy without exposing values. Unexpected runtime faults still exit and retain Compose restart behavior.

Acceptance has two separate lifecycle tests: (1) ordinary orchestration with bad managed configuration fails before creating/restarting light, with zero children; (2) a deliberate direct Compose startup bypass exercises defense in depth and produces one diagnostic, zero children, an alive/unhealthy parked container, no restart loop, and status-visible `configuration-error`. A valid configuration retains crash/restart behavior.

### Common managed proof and provider readiness

Every selected light surface, including heartbeat-only, requires the authoritative `HOME_KEYS_PATH`: exactly `${STATE_DIR}/home-keys.json` in-container, mapped from exactly `${TENANT_STATE}/.mail-agent/home-keys.json` on the managed host. It must be a regular file, at most **16 KiB**, JSON object root, and have required fields. `tenant` must satisfy exactly baxctl's current authoritative predicate `^[a-z0-9][a-z0-9-]*$`; it has **no separate length maximum today**, because baxctl currently has none. Adding one needs a separately approved, control-plane-first migration. `endpoint` is at most **2,048 bytes**, `accessKeyId` at most **128 bytes**, and `secretAccessKey` at most **256 bytes**. Tenant/access-key/secret values must be nonempty after no trimming, contain no ASCII whitespace or control character, and endpoint must contain no control character or surrounding whitespace. Endpoint is an absolute `https:` URL with hostname, optional explicit port 1–65535, no userinfo/query/fragment, and pathname exactly `/svc/<tenant>` (no trailing slash, prefix, or alternate encoding).

Unknown JSON fields are allowed. The file is structural local proof, not signed/versioned/expiring/staleness-checked. Diagnostics identify only fixed categories/setting names.

`MAIL_KEYS_PATH` and `SMS_KEYS_PATH` are the approved key-file sources. Preflight and runtime must call the same effective-credential resolvers. For Mail, the environment `RESEND_API_KEY` is used when present and otherwise `MAIL_KEYS_PATH`; an empty/whitespace key, malformed file, empty required file field, or partial/invalid environment source is fatal when Mail is selected (valid file fallback is allowed only when `RESEND_API_KEY` is wholly absent). Mail also requires `RESEND_WEBHOOK_SECRET` to be wholly present, nonblank, and control-character-free in the environment, with no file fallback. `BAXTER_EMAIL` must be nonblank after trim and contain neither surrounding whitespace nor control characters. For SMS, all three environment credentials (`SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`) must be wholly present and valid or wholly absent; partial/empty/control-character values are fatal configuration errors. If wholly absent, a valid `SMS_KEYS_PATH` supplies all three; malformed/partial/empty file is fatal. If neither supplies a trio, SMS is explicit receive-only degraded state, not fleet-fatal.

| Selected surface | Required preflight |
|---|---|
| Home, Chat, Heartbeat | common proof only |
| Mail | common proof, `BAXTER_EMAIL`, wholly present nonblank/control-free environment `RESEND_WEBHOOK_SECRET` (no file fallback), effective `RESEND_API_KEY` resolver |
| SMS | common proof; effective SMS resolver or explicit receive-only degradation |

Privacy tests seed hostile secrets, email, phone, endpoint, and malformed payload canaries and prove none appears in diagnostics/status.

## Dependency and protocol scope

Initial standalone roots are exactly `scripts/discord-bot.ts` and `scripts/voice-bot.ts`. The boundary checker traverses every module transitively reachable from either root through static TypeScript `import`/`export ... from` edges, including type-only imports and re-exports. In every such reachable module, it rejects both literal dynamic `import("...")` edges and nonliteral dynamic imports as unverifiable. It does not traverse command strings.

Forbidden files are: `scripts/light-bot.ts`, `home-bot.ts`, `chat-bot.ts`, `sms-bot.ts`, `mail-bot.ts`; `home-link.ts` and every module under `scripts/links/`; `home-mirror.ts`, `calendar-mirror.ts`, `recipes-mirror.ts`, `schedule-mirror.ts`, and `checklist-mirror.ts`; and tenant/home-key parsing or provisioning modules. `checklist-mirror.ts` is therefore forbidden and the existing Discord-root import must be removed/replaced as part of this boundary work. `link-cli.ts`, shared path constants, command-string tool grants, and staged skills are explicitly excluded from this first check and require a separately listed capability audit. The check uses this maintained explicit list/classifier and a deliberate fixture violation.

No protocol artifact changes are in this release: existing message/provisioning documents and fixtures remain unchanged. Wire versions, incompatible-version handling, unknown authority fields, and protocol hardening remain separately approved work.

## Atomic release, migration, and verification

The core release atomically includes enforcement and README, `app/.env.example`, `bin/baxter` help/status, root and app `CLAUDE.md`, `app/docs/architecture/home.md`, `app/docs/architecture/discord.md`, `app/skills/help-user-setup/SKILL.md`, `deploy/README.md`, `docs/RELEASING.md`, relevant Make/Compose comments, and install output/documentation. `app/docs/architecture/discord.md` and `app/skills/help-user-setup/SKILL.md` must use mode-correct fleet, default, and setup wording. The hosted `oss.bax.bot` quick-installer artifact is the public `install.sh` at `ehopealot/baxter-site`, owned and deployed by `ehopealot`; it is a coordinated external artifact.

Phase 1 does **not** install resolver-aware units. It only writes/audits managed mode using old-compatible units: `baxctl add`; imports both with and without an old env; template seeding; archive rehydrate; repair/regeneration/rewrite paths; and generic `setenv BAXTER_DEPLOYMENT_MODE` (which may set only exact `managed` for managed tenants, rejects `standalone`/empty/invalid, and cannot remove the key). Every such path preserves/writes `BAXTER_DEPLOYMENT_MODE=managed`. Inventory all active tenants before activation.

Phase 2 is one coordinated barrier: publish resolver-aware core, units/orchestration, control changes, public documentation, and hosted installer together. `docs/RELEASING.md` must replace old-host/no-external-artifact guidance with the exact coordinated external-artifact procedure: `ehopealot` owns `ehopealot/baxter-site`; create immutable annotated release tag `open-core-boundary-v1` pointing to the reviewed `install.sh` commit; record that commit and the source SHA-256 of its `install.sh`; upload/serve those exact bytes at `https://oss.bax.bot/install.sh`; fetch that URL with cache bypass before activation; and prove byte-for-byte and SHA-256 equality with the tagged source artifact. It must document rollback as restoring the previous coherent control/core/units/docs/installer set together, never activating a mixed resolver-aware unit with an old core. A moving `main` ref is never release evidence. Then run core `make check`, outer `make check`, outer `make check-root`, resolver/transition/Compose gates, and this hosted-installer verification; then activate units. A tenant lacking mode at activation resolves standalone; it is never inferred from keys, secrets, or surfaces.

## Acceptance and implementation status

Table tests cover every source-table row, BOM/CRLF/comments/`export`/whitespace/quotes/inline-comments/malformed-file cases, duplicate assignments, semantic parsing, and only-safe logging. Stateful tests cover configured versus `all` effective state, aliases, voice image failure, no-argument restart, invalid-config observation, all failure-table outcomes, service removal/voice retention, and standalone/managed transitions. Preflight tests cover all bounds/readiness/fallback cases, privacy canaries, terminal-status lifecycle, both separate Compose tests, and the exact `HOME_KEYS_PATH` mappings: `${STATE_DIR}/home-keys.json` in-container and `${TENANT_STATE}/.mail-agent/home-keys.json` on the managed host. Dependency tests cover both roots and transitive forbidden imports. Documentation checks cover the complete atomic inventory, including mode-correct fleet/default/setup wording in `app/docs/architecture/discord.md` and `app/skills/help-user-setup/SKILL.md`, plus the exact coordinated `ehopealot/baxter-site` installer owner/tag/recorded-commit/SHA-256/cache-bypassed byte-equality/rollback procedure in `docs/RELEASING.md`.

Later implementation runs core `make check`, outer `make check`, outer `make check-root`, all Compose lifecycle/transition gates, the hosted-installer byte/hash gate, and dependency fixtures for both roots plus a transitive reachable-module dynamic-import violation. Implementation is explicitly deferred: this specification changes no runtime code, orchestration, configuration, tests, or user-facing behavior.
