# Production drain

`drain-state.json` in the shared app state mount is the cross-surface admission
valve. `runAgent({ drainManaged: true })` atomically obtains a durable lease or
refuses when draining. Leases are released in `finally`.

`make drain` takes the per-fleet lifecycle `flock`, invokes `drain-cli begin`,
and sends `SIGUSR1` to running discord, light, and voice containers. Docker local
container control is the authentication boundary: there is intentionally no TCP
or HTTP drain endpoint. The in-process signal registry closes intake: HomeLinks
stop/reconnect no more, Discord/voice clients close, dispatcher timers and queued
work are discarded, and heartbeat's valve closes. Work already holding a lease is
not cancelled; the orchestrator polls leases to zero.

On timeout the marker and containers are retained and `make drain` fails. On
success it uses compose `stop` only for discord/light/voice; it never runs compose
`down` or `docker rm -f`. `make run` holds the same lock and clears the marker only
when no leases remain, before starting containers.
