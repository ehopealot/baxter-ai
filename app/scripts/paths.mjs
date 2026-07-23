// Where this app's persistent state lives, all under the config volume
// mounted at /home/node so it survives container restarts. Centralized
// here rather than redefined per-file (each daemon and CLI used to hardcode its
// own credential/state paths independently) so the paths can't drift apart.
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";

const STATE_DIR = join(homedir(), ".mail-agent");

export const SEND_STATE_PATH = join(STATE_DIR, "send-state.json");
export const DISCORD_SEND_STATE_PATH = join(STATE_DIR, "discord-send-state.json");
// The Discord bot token, persisted here (0600) by discord-bot.mjs at startup so
// discord-cli can read it from a file instead of the environment -- the spawned
// run's env has DISCORD_BOT_TOKEN stripped, so it can't exfiltrate the token via
// an allowed `discord-cli` command. Mirrors how mail.mjs reads agentmail-key.json
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

// The AgentMail API key, persisted here (0600) by poll.mjs/heartbeat.mjs at
// startup so mail.mjs can read it from a file instead of the environment -- the
// spawned run's env has AGENTMAIL_API_KEY stripped (runtime.mjs's runAgent), so
// it can't exfiltrate the key via an allowed `mail.mjs` command or shell
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
// poll.mjs's ensurePlaywrightConfig() writes into the same directory --
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

// Per-channel Discord memory. Lives under the run cwd so the sandbox permits
// writes; one file per channel/DM id. channelId comes from Discord and is a
// numeric snowflake string, so it's filesystem-safe as-is, but basename() it
// defensively in case a caller ever passes something odd.
export function discordChannelMemoryPath(channelId) {
  return join(MEMORY_DIR, "discord", `${basename(String(channelId))}.md`);
}
