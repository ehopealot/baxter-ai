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
export const MAIL_CLI = join(APP_DIR, "scripts", "mail.mjs");
export const DISCORD_CLI = join(APP_DIR, "scripts", "discord-cli.mjs");

// Tools every surface grants: the offline code sandbox, the workspace read window,
// keyless web fetch, both browsers, native web research, on-demand Skill loading,
// and the (cwd-confined) memory writes. The per-surface CLI grants below prepend.
const CORE_TOOLS =
  "Bash(code-cli *) Bash(files-cli *) Bash(projects-cli *) Bash(data-cli *) Bash(skills-cli *) Bash(web-cli *) Bash(playwright-cli *) Bash(invisible-cli *) WebSearch WebFetch Skill Read Write Edit";

// Per-surface allow-lists. Deliberate asymmetries (unchanged from the old inline
// strings):
//  - mail: mail + schedule-cli (an email run may schedule); NOT discord.
//  - discord: discord + schedule-cli (a chat run may schedule); NOT mail.
//  - heartbeat: mail + discord (a fired task may deliver to either surface) but
//    NOT schedule-cli -- a scheduled task must never schedule/cancel tasks.
export const MAIL_TOOLS = `Bash(node ${MAIL_CLI} *) Bash(schedule-cli *) ${CORE_TOOLS}`;
export const DISCORD_TOOLS = `Bash(node ${DISCORD_CLI} *) Bash(discord-cli *) Bash(schedule-cli *) ${CORE_TOOLS}`;
export const HEARTBEAT_TOOLS = `Bash(node ${MAIL_CLI} *) Bash(node ${DISCORD_CLI} *) Bash(discord-cli *) ${CORE_TOOLS}`;

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

// ONE base skill list -- append new skills HERE (e.g. via `make add-skill`) and
// every surface picks them up, minus its own exclusions below.
export const SKILL_NAMES = ["playwright-cli", "invisible-playwright", "discord", "code", "schedule", "web", "projects", "data", "skill-discovery", "skill-creator"];

// Each surface derives its staged skills by FILTERING the base list. The exclusions
// are the only skill asymmetries, and each mirrors a missing tool so a run never
// carries a doc for a capability it lacks:
//  - mail excludes `discord` (it has no discord-cli tool).
//  - heartbeat excludes `schedule` (no schedule-cli -- a fired task can't schedule).
//  - discord + voice exclude nothing.
// The tool grants above remain the real, FAIL-CLOSED boundary; these exclusions only
// keep the docs consistent (a staged doc never grants its tool). One base list means
// a skill added there flows to every surface automatically, minus its exclusions.
const skillsExcept = (...exclude) => skillSrcs(SKILL_NAMES.filter((n) => !exclude.includes(n)));
export const MAIL_SKILL_SRCS = skillsExcept("discord");
export const DISCORD_SKILL_SRCS = skillsExcept();
export const HEARTBEAT_SKILL_SRCS = skillsExcept("schedule");

// The staged skill NAMES per surface (same filter as the SRCS above), for the prompt's
// "skills already loaded" line. Derived from SKILL_NAMES so `make add-skill` surfaces a
// new baked skill to the model automatically -- the prompt list used to be hardcoded and
// silently drifted (skill-creator/web/projects/data/skill-discovery were all missing, so
// the model didn't know they were installed). loadedSkillsList formats them for the prompt.
const skillNamesExcept = (...exclude) => SKILL_NAMES.filter((n) => !exclude.includes(n));
export const MAIL_SKILL_NAMES = skillNamesExcept("discord");
export const DISCORD_SKILL_NAMES = skillNamesExcept();
export const HEARTBEAT_SKILL_NAMES = skillNamesExcept("schedule");
export const loadedSkillsList = (names) => names.map((n) => `\`${n}\``).join(", ");

// The floor for the learned-skill shadow guard: a learned skill may never take one
// of these names (see ensureSkills). The union of the surfaces is exactly the base
// list (each surface is a subset), so derive it from SKILL_NAMES directly -- a skill
// added there is covered automatically and the guard can't silently go stale.
// `basename` so it matches whether the source is under BUILD_SKILLS_DIR or REPO_SKILLS_DIR.
export const BAKED_SKILL_NAMES = new Set(skillSrcs(SKILL_NAMES).map((s) => basename(s)));
