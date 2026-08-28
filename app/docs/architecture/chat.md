# Home Chat agent dispatch

The Home Chat container daemon (`scripts/chat-bot.ts`) receives ordered browser intents over the signed chat link. A successful `send-message` first appends the household-authored message to the locked chat transcript, then persists one immutable tenant-scoped `chat` agent-dispatch envelope in the shared queue-admission outbox. Only after that admission may the cursor advance or the link ACK the sequence.

The chat dispatcher owns each admitted envelope's lifecycle. It marks an attempt running before invoking the scoped run, records success, retries transient failures with backoff, and records a durable chat dead letter before a permanent failure becomes terminal. On startup it converts interrupted running envelopes to retryable work and replays pending work without re-admitting or duplicating a dispatch. Coalescing only batches scheduling; every work ID retains an independent durable outcome.

Resident deployments without the outbox injection preserve the existing chat dispatcher behavior. Auto-titling and the morning-handoff sidecar remain post-admission work so neither can create an accepted, untracked agent turn.
