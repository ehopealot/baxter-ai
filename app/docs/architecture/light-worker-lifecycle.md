# Light worker lifecycle

The shared `light` process owns one `LightLifecycle` for mail, SMS, Home Chat,
Home, and heartbeat. Links, renewable watches, renderer/supervisor timers, and
the heartbeat sleep timer are intake sources: shutdown closes them before the
idle observation, and a denied exit recreates them before intake reopens.
Dispatcher ownership is uninterrupted across debounce, waiting, active work,
and durable outcome persistence. The tenant-wide queue outbox also holds one
lifecycle blocker for every nonterminal mail/SMS/chat record, including work
waiting for retry.

On SIGTERM/SIGINT the supervisor closes intake and applies one absolute
25-second deadline to worker-control drain, local admitted-work drain, and the
final typed `exitPermitted` check. Permission closes final resources; a denied
check truly reopens sources. Deadline expiry closes resources and exits rather
than allowing a hung control RPC or final check to exceed SIGTERM's bound.

In worker mode core uses only `WorkerControlClient`'s typed boundary. It sends
`hello` at supervisor startup. One queue-scoped coverage coordinator serializes
monotonic mail/SMS/chat/Home high-water reports made only after durable cursor
or admission completion, retains failures as lifecycle blockers, and replays
durable cursor values after hello/startup and denied-exit reopen. One shared
per-tenant outbox classifies every mail/SMS/chat source sequence as exactly one
agent-dispatch or source-named non-agent terminal record. Socket framing and
runner-side authority remain outside core.

Every direct provider request, including collection rendering and moderation,
passes through `ProviderLeaseTransport`. A permit is accepted only for the
bound lease generation and while unexpired, is rechecked after the response,
and remains local control data rather than leaking in provider headers.
