# Light worker lifecycle

The shared `light` process owns one `LightLifecycle` for mail, SMS, Home Chat,
Home, and heartbeat. Links, renewable watches, renderer/supervisor timers, and
the heartbeat sleep timer are intake sources: shutdown closes them before the
idle observation, and a denied exit recreates them before intake reopens. Every
socket callback acquires its lifecycle token synchronously, before handing work
to a promise chain. Reopen is fail-closed: one failed source rolls back the
sources already reopened, leaves admission closed, and retries the complete
source set. Explicitly stopped links reject stale reconnect requests.
Dispatcher ownership is uninterrupted across debounce, waiting, active work,
and durable outcome persistence. Raw chat/checklist/recipe/calendar/schedule
watch events acquire their token before arming the debounce; closing watcher
intake leaves a mature lifecycle-owned debounce to drain. The tenant-wide queue
outbox also holds one
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

Every direct provider request, including collection rendering, Home sorting,
calendar refresh and publication, morning check-in feed reads, Resend SDK/Chat
adapter traffic, Discord REST/webhook delivery, SMS, welcome mail, and
moderation, passes through
`ProviderLeaseTransport`. A permit is accepted only for the bound lease
generation and while unexpired, remains registered through response-body
consumption, and is renewed/rechecked only after parsing before provider output
is published. Revocation aborts both the fetch and an in-progress body consumer;
moderation rethrows that authority loss rather than treating it as a fail-open
provider outage. Permit data remains local and never leaks in provider headers.
The worker-control
revocation signal aborts all registered requests/body consumers immediately;
response cancellation is itself renewed and generation/expiry-validated before
its permit is released. Calendar polling and chat titling propagate typed lease
revocation instead of degrading it into ordinary provider failure.

Mail/SMS/chat cursors re-fsync a surviving cursor inode and parent before a new
process trusts it; live uncertain renames retain a replay floor. Loaded queue
outboxes and existing transcript receipt rows similarly repair their file and
directory barriers before publication. Source and agent dead letters are
idempotent by outcome/work ID, and calendar cache replacement fsyncs its temp
inode and containing directory before publishing a selection-ready snapshot.

Collection-renderer close stops only external intake. Mature debounce and retry
timers, queued generations, and the active model call drain under their existing
lifecycle ownership; only final permitted/deadline teardown may abort them.
Calendar refresh overrides queued behind an active poll likewise retain a
separate lifecycle token and run during drain. Worker shutdown is installed
before `hello`; hello, dynamic imports, and each finite surface startup are
lifecycle-tracked.
