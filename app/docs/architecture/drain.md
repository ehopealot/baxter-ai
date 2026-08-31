# Production drain

`drain-state.json` in the shared app state mount is the cross-surface admission
valve. `runAgent({ drainManaged: true })` atomically obtains a durable lease or
refuses when draining. Leases are released in `finally`.

`make drain` first takes a checkout-wide image-build `flock`, then atomically
ensures the current checkout's content-addressed app image is local. Thus tenants
sharing a checkout build a missing tag once before any takes its per-fleet lifecycle
`flock`. The per-fleet lock is the stable parent directory of `TENANT_ENV`, rather
than a `/tmp` regular file: systemd starts run as the box user while administrative
drains can run as root, and Linux rejects cross-UID `O_CREAT` opens of regular files
in sticky `/tmp`. It then invokes `drain-cli begin` and sends `SIGUSR1` to running
discord and light containers. Docker local container control is the authentication boundary:
there is intentionally no TCP or HTTP drain endpoint. The in-process signal
registry closes intake: HomeLinks stop/reconnect no more, Discord clients close,
dispatcher timers and queued
work are discarded, and heartbeat's valve closes. Work already holding a lease is
not cancelled; the orchestrator polls leases to zero.

On timeout the marker and containers are retained and `make drain` fails. On
success it uses compose `stop` only for discord/light; it never runs compose
`down` or `docker rm -f`. `make run` holds the same lock and clears the marker only
when no leases remain, before starting containers.

When any compose app daemon starts while the marker is active, it atomically claims
one best-effort post to `DISCORD_ALERT_WEBHOOK`. The claim is durable and reset by
clear, recovery, or a new drain generation, so a fleet restart emits at most one
alert. Starting `make drain` itself never posts an alert; leaving the webhook unset
disables this observability signal.

If an unclean host shutdown strands durable leases, **do not clear the state file
or run `drain-cli recover` directly**. Run `make recover-drain`: it shares the
same image preflight as `make drain` and `make clear-drain`, so an unavailable
control image fails before recovery stops any container. Under the same fleet
lock it stops discord and light, verifies each is no longer running with Docker
inspect, then invokes the recovery command to clear the marker and stranded
leases. `make run` intentionally refuses a marker with leases and tells the
operator to use this workflow; it never blindly deletes live-lease evidence.
