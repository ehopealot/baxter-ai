// Single source of truth for the scoped run's tool allow-list and the skills
// staged into its cwd, shared by the three claude-spawning daemons (poll/discord/
// heartbeat). Before this module each daemon carried its own ALLOWED_TOOLS string
// and SKILL_SRCS array, and runtime.mjs hardcoded the union of skill names for the
// learned-skill shadow guard -- app/CLAUDE.md flagged "three allow-rule sources
// that must stay in sync" as a live drift hazard on a security boundary. Defining
// each surface once here, composed from shared pieces, removes it: the tool
// strings are built from a common core, and BAKED_SKILL_NAMES is DERIVED from the
// surface skill lists (so adding a skill to a surface can't leave the guard stale).
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// grants.mjs lives in APP_DIR/scripts, so this resolves to APP_DIR.
const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
// Absolute paths to the two credential-boundary CLIs. Exported so the daemons
// import them rather than recomputing the same join() -- the path granted in the
// allow-list here and the path a daemon injects into the run's prompt / invokes
// directly MUST be the same string, or a moved file silently breaks the
// `Bash(node <path> *)` grant. One definition removes that drift hazard.
export const GMAIL_CLI = join(APP_DIR, "scripts", "gmail.mjs");
export const DISCORD_CLI = join(APP_DIR, "scripts", "discord-cli.mjs");

// Tools every surface grants: the offline code sandbox, the workspace read window,
// keyless web fetch, both browsers, native web research, on-demand Skill loading,
// and the (cwd-confined) memory writes. The per-surface CLI grants below prepend.
const CORE_TOOLS =
  "Bash(code-cli *) Bash(files-cli *) Bash(web-cli *) Bash(playwright-cli *) Bash(invisible-cli *) WebSearch WebFetch Skill Read Write Edit";

// Per-surface allow-lists. Deliberate asymmetries (unchanged from the old inline
// strings):
//  - mail: gmail + schedule-cli (an email run may schedule); NOT discord.
//  - discord: discord + schedule-cli (a chat run may schedule); NOT gmail.
//  - heartbeat: gmail + discord (a fired task may deliver to either surface) but
//    NOT schedule-cli -- a scheduled task must never schedule/cancel tasks.
export const MAIL_TOOLS = `Bash(node ${GMAIL_CLI} *) Bash(schedule-cli *) ${CORE_TOOLS}`;
export const DISCORD_TOOLS = `Bash(node ${DISCORD_CLI} *) Bash(discord-cli *) Bash(schedule-cli *) ${CORE_TOOLS}`;
export const HEARTBEAT_TOOLS = `Bash(node ${GMAIL_CLI} *) Bash(node ${DISCORD_CLI} *) Bash(discord-cli *) ${CORE_TOOLS}`;

// Skills staged into each run's cwd .claude/skills (see ensureSkills in
// runtime.mjs). playwright-cli's skill is generated at BUILD under .claude/skills;
// the rest ship in the repo's skills/. Each surface is a plain name list, resolved
// to source dirs by skillSrcs().
const BUILD_SKILLS_DIR = join(APP_DIR, ".claude", "skills");
const REPO_SKILLS_DIR = join(APP_DIR, "skills");
function skillSrc(name) {
  return join(name === "playwright-cli" ? BUILD_SKILLS_DIR : REPO_SKILLS_DIR, name);
}
function skillSrcs(names) {
  return names.map(skillSrc);
}

const MAIL_SKILL_NAMES = ["playwright-cli", "invisible-playwright", "code", "schedule", "web"];
const DISCORD_SKILL_NAMES = ["playwright-cli", "invisible-playwright", "discord", "code", "schedule", "web"];
// heartbeat omits schedule (a fired task can't schedule) but keeps discord (it may
// deliver to Discord); its tool list mirrors this.
const HEARTBEAT_SKILL_NAMES = ["playwright-cli", "invisible-playwright", "discord", "code", "web"];

export const MAIL_SKILL_SRCS = skillSrcs(MAIL_SKILL_NAMES);
export const DISCORD_SKILL_SRCS = skillSrcs(DISCORD_SKILL_NAMES);
export const HEARTBEAT_SKILL_SRCS = skillSrcs(HEARTBEAT_SKILL_NAMES);

// The cross-daemon floor for the learned-skill shadow guard: a learned skill may
// never take one of these names (see ensureSkills). DERIVED as the union of the
// surface lists above -- so a skill added to any one surface is covered here
// automatically and the guard can't silently go stale. `basename` so it matches
// whether the source is under BUILD_SKILLS_DIR or REPO_SKILLS_DIR.
export const BAKED_SKILL_NAMES = new Set(
  [...MAIL_SKILL_SRCS, ...DISCORD_SKILL_SRCS, ...HEARTBEAT_SKILL_SRCS].map((s) => basename(s)),
);
