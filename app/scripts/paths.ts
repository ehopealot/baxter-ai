// Where this app's persistent state lives, all under the config volume
// mounted at /home/node so it survives container restarts. Centralized
// here rather than redefined per-file (each daemon and CLI used to hardcode its
// own credential/state paths independently) so the paths can't drift apart.
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";

const STATE_DIR = join(homedir(), ".mail-agent");

// Per-surface dead-letter logs (dead-letter.ts): one JSONL file per SIDE-EFFECTFUL surface
// (chat, sms) holding intents/inbounds whose handler failed non-retryably, so the drain can
// advance its cursor + ack (moving on, never re-dispatching the run) while preserving the
// message for inspection/replay. In STATE_DIR (not MEMORY_DIR) so it's outside the run's
// workspace, beside the other durable daemon state. (home doesn't use it -- its pure,
// idempotent checklist intents withhold-and-redeliver via failedFloor instead.)
export const DEAD_LETTER_DIR = join(STATE_DIR, "dead-letter");

export const SEND_STATE_PATH = join(STATE_DIR, "send-state.json");
export const DISCORD_SEND_STATE_PATH = join(STATE_DIR, "discord-send-state.json");
// The Discord bot token, persisted here (0600) by discord-bot.ts at startup so
// discord-cli can read it from a file instead of the environment -- the spawned
// run's env has DISCORD_BOT_TOKEN stripped, so it can't exfiltrate the token via
// an allowed `discord-cli` command. Mirrors how mail.ts reads agentmail-key.json
// rather than env. Outside the run's cwd (memory-workspace), like the other
// credential files.
export const DISCORD_TOKEN_PATH = join(STATE_DIR, "discord-token.json");

// API keys for data-cli's keyed sources: a flat { "KEY_NAME": "secret", ... }
// JSON file (0600), keyed by each registry source's `auth.keyName`. Lives here
// in STATE_DIR alongside the agentmail/discord key files -- OUTSIDE MEMORY_DIR -- so
// files-cli (workspace-confined) can't enumerate it and the run's env carries
// no key. Same accepted residual as the tokens: native Read by exact path is
// still possible under the claude harness (see app/CLAUDE.md); onboard only keys
// whose blast radius fits that. A keyless source needs no entry (no file at all).
export const DATA_KEYS_PATH = join(STATE_DIR, "data-keys.json");

// The AgentMail API key, persisted here (0600) by poll.ts/heartbeat.ts at
// startup so mail.ts can read it from a file instead of the environment -- the
// spawned run's env has AGENTMAIL_API_KEY stripped (runtime.ts's runAgent), so
// it can't exfiltrate the key via an allowed `mail.ts` command or shell
// interpolation. Same accepted residual as the other credential files (native
// Read by exact path). Outside the run's cwd, like the discord/data key files.
export const AGENTMAIL_KEY_PATH = join(STATE_DIR, "agentmail-key.json");

// The mail poll cursor (epoch-ms): the timestamp boundary list-new lists from,
// held one margin below the oldest not-yet-handled message. An efficiency bound
// only -- the agent-processed label is the exactly-once source of truth.
export const MAIL_POLL_CURSOR_PATH = join(STATE_DIR, "mail-poll-cursor.json");

// Freeform notes the agent reads at the start of every run and can update
// via Write/Edit -- the only cross-thread memory it has. Everything else
// (thread transcripts, browser cookies) is scoped to a single thread or is
// opaque state a run can't read back as text.
//
// Lives in its own subdirectory, not alongside agentmail-key.json / discord-token.json etc: the
// claude -p run's filesystem sandbox restricts writes to its cwd, and
// --allowedTools' Write(<path>)/Edit(<path>) per-file scoping was tested
// and doesn't actually get approved headlessly in this CLI version (only
// bare, unscoped Write/Edit does) -- so the run's cwd IS this directory,
// with unscoped Write/Edit granted. Isolating it means that unscoped grant
// can still only ever reach memory.md (plus the .playwright/ config
// poll.ts's ensurePlaywrightConfig() writes into the same directory --
// a default the run can overwrite, not a hard control), not the other
// state files.
export const MEMORY_PATH = join(STATE_DIR, "memory-workspace", "memory.md");

// The directory MEMORY_PATH lives in -- also the cwd of every claude -p run
// (email/Discord/heartbeat/voice-dispatch), so it holds the shared memory.md, the run's
// .claude/skills (including ad-hoc skills the agent writes), and Discord's
// per-channel memory files below. Writes are sandbox-bounded to this dir.
export const MEMORY_DIR = dirname(MEMORY_PATH);

// Dedicated store for account credentials (site/URL/username/password), kept
// separate from memory.md so the secret surface is one auditable file. Shared
// across all four surfaces (same MEMORY_DIR); the prompts route credentials here and
// leave only a pointer in memory.md.
export const CREDENTIALS_PATH = join(MEMORY_DIR, "CREDENTIALS.md");

// Cross-cutting project notes -- one markdown file per project, shared across
// all four surfaces (same MEMORY_DIR), so a project Baxter opens in a Discord run
// carries the same context an email run sees, and vice versa. Managed via
// projects-cli (make/list/open/save); the directory is created lazily on first
// `make`. Under the run cwd, so the sandbox permits the writes.
export const PROJECTS_DIR = join(MEMORY_DIR, "projects");

// Where the agent authors its OWN skills. It can't write into .claude/skills
// (Claude Code guards its own .claude dir against agent writes), so it writes
// here -- a plain dir under its writable cwd -- and the daemon stages each
// subdir into .claude/skills each run (see ensureSkills). Shared across all four
// surfaces (same MEMORY_DIR), so a skill learned via Discord is available to
// heartbeat, voice, and email runs too, and vice versa.
export const LEARNED_SKILLS_DIR = join(MEMORY_DIR, "learned-skills");

// Heartbeat scheduler state (shared across the email/Discord/voice-dispatch runs,
// which add/cancel via schedule-cli, and the dedicated heartbeat driver, which fires).
export const SCHEDULE_PATH = join(STATE_DIR, "schedule", "schedule.json");
export const SCHEDULE_LOG_PATH = join(STATE_DIR, "schedule", "task-log.jsonl");

// Calendar state. In STATE_DIR (NOT MEMORY_DIR) so calendar-cli is the ONLY writer
// and its proper-lockfile actually gates every write -- under MEMORY_DIR the run's
// native Write/Edit could bypass the lock and clobber a concurrent add (same reason
// the schedule state lives here). `events.json` is Baxter's OWN published events;
// `family-cache.json` caches the polled read-only family feed.
export const CALENDAR_EVENTS_PATH = join(STATE_DIR, "calendar", "events.json");
export const CALENDAR_CACHE_PATH = join(STATE_DIR, "calendar", "family-cache.json");

// The subscribe-side feed URLs the home DO pushes down the link (0600, home-bot is the SOLE
// writer via applyCalendarFeedsCommand; calendar-cli reads fresh each poll). Beside the
// cache, in STATE_DIR.
export const CALENDAR_FEEDS_PATH = join(STATE_DIR, "calendar", "feeds.json");

// Object-storage credentials + feed config for publishing the ICS (0600, in STATE_DIR
// beside the other key files -- OUTSIDE MEMORY_DIR, so not in the run's env or reachable
// by files-cli; native Read by exact path is the accepted residual, like data-keys).
// Per-tenant. Shape: { endpoint, bucket, region, accessKeyId, secretAccessKey, objectKey }.
export const CALENDAR_KEYS_PATH = join(STATE_DIR, "calendar-keys.json");

// Checkable-item lists (checklist-cli): groceries, packing, todos -- items get checked
// off then cleared. In STATE_DIR (NOT MEMORY_DIR) so checklist-cli is the only writer and
// its proper-lockfile gates writes, like the calendar/schedule stores. Distinct from
// PROJECTS_DIR (aggregating notes, not checkable items).
export const CHECKLISTS_PATH = join(STATE_DIR, "checklists", "checklists.json");

// File-access log (LRU tracking): one JSONL event per read/write the agent does through the
// structured harness's read_file/write_file/edit_file (the cwd-confined choke point -- see
// harnesses/openrouter-tools.ts), keyed by MEMORY_DIR-relative path. In STATE_DIR, NOT
// MEMORY_DIR, so it isn't itself a tracked workspace file (no self-referential churn) and the
// run can't read/tamper with it. Append-only on the hot path (lock-free); folded on read;
// compacted lock-free (atomic rename, last writer wins) when it grows. Advisory data --
// best-effort, never fatal.
export const ACCESS_LOG_PATH = join(STATE_DIR, "file-access", "log.jsonl");

// Per-tenant model-usage ledger (one best-effort JSONL append per run) + its
// once-per-period alert sentinels. In STATE_DIR (per-tenant config volume), so
// it's automatically per-tenant and survives restarts. See usage-store.ts.
export const USAGE_DIR = join(STATE_DIR, "usage");

// Family-home web mirror (home-bot). Signed-sync credentials for the control-plane
// Durable Object (0600, STATE_DIR, beside calendar-keys -- OUTSIDE MEMORY_DIR). Written
// by baxctl at provisioning. Shape: { endpoint, tenant, accessKeyId, secretAccessKey }.
export const HOME_KEYS_PATH = join(STATE_DIR, "home-keys.json");
// The home surface's durable sync cursor + publish latches (appliedThrough, the
// last-published viewVersion, the 413 latches). In STATE_DIR next to the checklist store --
// the home surface is its ONLY writer, so a plain atomic write suffices (no cross-process
// lock like the checklist store, which has two writers). Crash-safety of appliedThrough
// lives here: it is persisted per-applied-intent, not per-batch.
export const HOME_STATE_PATH = join(STATE_DIR, "home", "sync-state.json");

// The shared runtime allow-list every surface container reads FRESH on each call (home-bot is
// the SOLE writer -- it applies the DO's command snapshots here). 0600, STATE_DIR (config
// volume), so a change reaches the separate mail-poller process without a restart. app.env is a
// one-time SEED only: loadAllowlist (allowlist.ts) falls back to it when this file is
// absent/corrupt, and NEVER to "allow all" (fail-closed).
// NOTE: this sits at STATE_DIR/home/allowlist.json (beside HOME_STATE_PATH), a deliberate
// deviation from spec §5.3's `~/.mail-agent/allowlist.json` wording -- same config volume, one
// subdir deeper for tidiness alongside the other home-surface state.
export const ALLOWLIST_PATH = join(STATE_DIR, "home", "allowlist.json");

// Per-channel Discord memory. Lives under the run cwd so the sandbox permits
// writes; one file per channel/DM id. channelId comes from Discord and is a
// numeric snowflake string, so it's filesystem-safe as-is, but basename() it
// defensively in case a caller ever passes something odd.
export function discordChannelMemoryPath(channelId: string | number): string {
  return join(MEMORY_DIR, "discord", `${basename(String(channelId))}.md`);
}

// SMS surface state paths (following DISCORD_TOKEN_PATH/ALLOWLIST_PATH pattern)
// The SMS API keys (apiKey, apiSecret, fromNumber), persisted here (0600) at startup
// so sms-cli can read it from a file instead of the environment, like discord-token.json.
export const SMS_KEYS_PATH = join(STATE_DIR, "sms-keys.json");
// SMS container appliedThrough cursor (for sync-state tracking)
export const SMS_STATE_PATH = join(STATE_DIR, "sms", "sync-state.json");
// SMS send-state counter (flat name to avoid basename collision with email's send-state.json)
export const SMS_SEND_STATE_PATH = join(STATE_DIR, "sms-send-state.json");
// SMS conversation transcripts directory
export const SMS_TRANSCRIPT_DIR = join(STATE_DIR, "sms", "transcripts");

// Home Chats store: chat index + per-chat JSONL transcripts. In STATE_DIR (NOT
// MEMORY_DIR), like CHECKLISTS_PATH above -- the run's file-access sandbox never
// needs to reach it, so the lock (chat-transcript.ts's proper-lockfile) is the
// sole gate on concurrent writers.
export const CHATS_DIR = join(STATE_DIR, "chats");
// Home Chats container appliedThrough cursor (mirrors SMS_STATE_PATH's/HOME_STATE_PATH's
// shape and restart-safety role). A SIBLING dir to CHATS_DIR, not nested inside it --
// chat-transcript.ts's CHATS_DIR holds only index.json and per-chat id subdirectories
// (chat-transcript.ts's validateId), so a stray top-level file there risks confusion
// with that store even though no chat id could actually collide with this filename.
export const CHAT_STATE_PATH = join(STATE_DIR, "chat", "sync-state.json");
