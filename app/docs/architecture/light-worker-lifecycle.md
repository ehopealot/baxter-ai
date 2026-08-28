# Light worker lifecycle

The shared `light` process owns one `LightLifecycle` for mail, SMS, Home Chat,
Home, and heartbeat. Links, watches, renderers, dispatch retry schedulers, and
the heartbeat sleep timer register shutdown closers; admitted finite work keeps
its release until all asynchronous descendants settle.

On SIGTERM/SIGINT the supervisor closes intake, asks worker control to drain,
waits at most 25 seconds for admitted work, then performs the typed
`exitPermitted` check. It closes process handles only when that check permits
exit; a denied final check reopens intake so a racing wake is served rather
than lost.

In worker mode core uses only `WorkerControlClient`'s typed boundary. It sends
`hello` at supervisor startup, reports mail/SMS/chat coverage only after the
inbound handler has durably admitted or cursor-advanced that sequence, and
uses `drain` plus `exitPermitted` for shutdown. Socket framing and runner-side
authority remain outside core.
