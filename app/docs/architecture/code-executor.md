# Remote code executor

(part of Baxter — see [architecture map](../../CLAUDE.md))

`code-cli` is **remote-only**. Core contains no Codapi server, sandbox image,
Docker socket mount, or host-code fallback. It accepts only `python` or `node`,
optional UTF-8 `input`, and emits the existing stdout/stderr/result and framed
artifact contract.

## Fleet path

A fleet tenant runs `code-executor-signer`, a tiny sidecar with no TCP port,
model/Home/app credentials, tenant state mount, or user-code runtime. `baxctl
code <tenant>` writes its dedicated Cloudflare access key only to
`/agents/<tenant>/code-executor.env` (`root:<box-service-group>`, `0640`), which
Compose reads only for this service. The sidecar starts as root only to create a
shared socket directory, drops permanently to UID/GID 1000, and listens at
`/run/code-executor/exec.sock` (`0660 node:node`). App containers mount the
socket volume but never the signer env file.

`code-cli` sends a bounded JSON body over that Unix socket. The signer adds a
fresh SigV4 nonce and forwards HTTPS to the standalone Cloudflare executor
Worker. Browser/page JavaScript cannot open a Unix socket, and a prompt-injected
run can invoke `code-cli` only as the intentionally granted computation
capability; it cannot read or exfiltrate the signing key.

The Worker resolves an access-key ID through a fixed credential-directory DO
before it instantiates a tenant auth DO, so random public key sprays cannot create
unbounded tenant storage. It then determines tenant identity from the signed
credential, enforces one active tenant job and global admission, creates a fresh
no-internet Container, and destroys it after the result. See the outer
repository's Cloudflare executor design/runbook for Worker-side limits and
production gates.

## Self-hosted direct path

An intentional self-hosted deployment can omit the sidecar and explicitly set a
regular `0600` `CODE_EXECUTOR_KEYS_PATH`. `code-cli` signs directly to an HTTPS
executor origin; it never supplies a default key path. That mode has the documented harness-read exposure: a harness
that can read the file can spend only the credential's bounded executor quota.
It is not used by the Baxter fleet.

## Failure behavior

Remote configuration or transport failure is fail-closed. `code-cli` never
constructs a `CODAPI_URL` or contacts a host executor. `BAXTER_CODE_EXECUTOR`
may be absent/`remote`; `local` and any other nonempty value are errors. A tenant
must be provisioned with `baxctl code` before code execution is available. The
operator selected a hard cutover; see the outer production runbook's explicit
residual-risk record. `baxctl code --all --stage` then `--verify` remain
available for a future staged deployment. After a running hard cutover, execute
`node scripts/code-executor-verify.ts` as UID/GID 1000 in the signer container
to check its `0660` socket and bounded signed no-op. Whole-box restore disables
a signer socket until status and ownership verify; a stale key needs explicit
`baxctl code --recover`.
