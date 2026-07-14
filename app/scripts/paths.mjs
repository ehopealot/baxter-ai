// Where this app's persistent state lives, all under the config volume
// mounted at /home/node so it survives container restarts. Centralized
// here rather than redefined per-file (gmail.mjs and authorize.mjs used to
// each hardcode TOKEN_PATH independently) so the paths can't drift apart.
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";

const STATE_DIR = join(homedir(), ".mail-agent");

export const TOKEN_PATH = join(STATE_DIR, "gmail-token.json");
export const SEND_STATE_PATH = join(STATE_DIR, "send-state.json");
export const DISCORD_SEND_STATE_PATH = join(STATE_DIR, "discord-send-state.json");
export const REAUTH_REMINDER_PATH = join(STATE_DIR, "reauth-reminder.json");

// Freeform notes the agent reads at the start of every run and can update
// via Write/Edit -- the only cross-thread memory it has. Everything else
// (thread transcripts, browser cookies) is scoped to a single thread or is
// opaque state a run can't read back as text.
//
// Lives in its own subdirectory, not alongside gmail-token.json etc: the
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
// (email and Discord), so it holds the shared memory.md, the run's
// .claude/skills (including ad-hoc skills the agent writes), and Discord's
// per-channel memory files below. Writes are sandbox-bounded to this dir.
export const MEMORY_DIR = dirname(MEMORY_PATH);

// Per-channel Discord memory. Lives under the run cwd so the sandbox permits
// writes; one file per channel/DM id. channelId comes from Discord and is a
// numeric snowflake string, so it's filesystem-safe as-is, but basename() it
// defensively in case a caller ever passes something odd.
export function discordChannelMemoryPath(channelId) {
  return join(MEMORY_DIR, "discord", `${basename(String(channelId))}.md`);
}
