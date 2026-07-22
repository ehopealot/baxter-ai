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
  "Bash(code-cli *) Bash(files-cli *) Bash(projects-cli *) Bash(data-cli *) Bash(skills-cli *) Bash(web-cli *) Bash(playwright-cli *) Bash(invisible-cli *) WebSearch WebFetch Skill Read Write Edit";

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

// ONE base skill list -- append new skills HERE (e.g. via `make add-skill`) and
// every surface picks them up. Mail + Discord (+ voice) stage all of them via
// SKILL_SRCS; heartbeat stages all EXCEPT the ones it has no tool for. Skills track
// the tool grants (a run shouldn't carry docs for a capability it lacks), but the
// tool grants above remain the real, fail-closed boundary -- the skill list never
// grants a tool.
export const SKILL_NAMES = ["playwright-cli", "invisible-playwright", "discord", "code", "schedule", "web", "projects", "data", "skill-discovery"];
export const SKILL_SRCS = skillSrcs(SKILL_NAMES);

// Heartbeat's one deliberate exclusion: `schedule`. A fired task has no
// `schedule-cli` tool (HEARTBEAT_TOOLS denies it -- a scheduled task must never
// schedule/cancel more tasks), so it gets neither the tool nor its doc; the doc
// stays consistent with the (hard, fail-closed) tool boundary rather than dangling
// a capability the run can't use. This is the SOLE skill asymmetry, and it's
// derived from the one list above, so new skills still flow to all three.
const HEARTBEAT_SKILL_EXCLUDES = new Set(["schedule"]);
export const HEARTBEAT_SKILL_SRCS = skillSrcs(SKILL_NAMES.filter((n) => !HEARTBEAT_SKILL_EXCLUDES.has(n)));

// The floor for the learned-skill shadow guard: a learned skill may never take one
// of these names (see ensureSkills). DERIVED from the base list, so a skill added
// there is covered automatically and the guard can't silently go stale (heartbeat's
// list is a subset, so SKILL_SRCS's basenames are already the full union).
// `basename` so it matches whether the source is under BUILD_SKILLS_DIR or REPO_SKILLS_DIR.
export const BAKED_SKILL_NAMES = new Set(SKILL_SRCS.map((s) => basename(s)));
