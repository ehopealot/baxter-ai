# Remote code executor

(part of Baxter — see [architecture map](../../CLAUDE.md))

`code-cli` is **remote-only**. Core contains no Codapi server, sandbox image,
Docker socket mount, or host-code fallback. It accepts only `python` or `node`,
optional UTF-8 `input`, and emits the existing stdout/stderr/result and framed
artifact contract.

## Fleet path

A managed tenant’s `light` and `discord` containers sign bounded HTTPS
`/v1/exec` requests directly:

```text
light/discord code-cli -> signed HTTPS /v1/exec -> Cloudflare Worker -> fresh no-internet Container
```

`baxctl code <tenant>` writes the tenant-scoped Cloudflare credential to
`/agents/<tenant>/code-executor.env` (`root:<box-service-group>`, `0640`).
Compose loads that file last for both application services. It is not copied to
`app.env`, placed in a URL, logged, sent to the remote Container, or available
to another tenant.

The application containers are deliberately the credential boundary. `code-cli`
validates a bounded JSON body, creates a fresh SigV4 nonce, and signs the fixed
HTTPS request with the direct environment credential. A run that can invoke
`code-cli` therefore has the bounded execution capability; treat the scoped
credential as reachable within that app-container trust boundary. It can submit
jobs only as its own tenant and cannot use the Worker admin API, provision,
rotate, revoke, or access another tenant’s state. A stolen credential can submit
bounded jobs and consume tenant/global executor capacity until revoked; this is
an accepted incremental exposure because application containers already contain
higher-authority tenant credentials.

There is no signer sidecar, Unix socket, socket volume, root bootstrap,
`CODE_EXECUTOR_SOCKET`, or `CODE_EXECUTOR_KEYS_PATH` transport. Those retired
settings fail closed. Missing, partial, or malformed direct configuration also
fails closed; no local executor is constructed.

The Worker resolves an access-key ID through a fixed credential-directory DO
before it instantiates a tenant auth DO, so random public key sprays cannot create
unbounded tenant storage. It then determines tenant identity from the signed
credential, enforces one active tenant job and global admission, creates a fresh
no-internet Container, and destroys it after the result. See the outer
repository's Cloudflare executor design/runbook for Worker-side limits and
production gates.

## Failure and recovery behavior

`BAXTER_CODE_EXECUTOR` must be `remote`, with complete direct credential
variables supplied by the final credential env file. `local`, an invalid mode,
a retired socket/key-file selector, or incomplete credentials are errors.
`code-cli` never constructs a `CODAPI_URL` or contacts a host executor.

A tenant must be provisioned with `baxctl code` before code execution is
available. The operator selected a hard cutover; see the outer production
runbook's explicit residual-risk record. `baxctl code --all --stage` then
`--verify` remain available before the fleet restart. Before fleet rollout,
execute `node scripts/code-executor-verify.ts` as UID/GID 1000 in the running
`light` container. It runs a bounded signed identity canary that requires the
remote runner to have UID/EUID and GID/EGID 10001, no supplementary groups or
capabilities, no-new-privileges, and no ability to regain UID 0. Whole-box
restore keeps direct execution unavailable until the restored credential's
ownership and Worker status verify; a stale key needs explicit
`baxctl code --recover`.
