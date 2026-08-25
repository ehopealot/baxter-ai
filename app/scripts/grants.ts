// Single source of truth for the scoped run's tool allow-list and the skills
// staged into its cwd, shared by the four claude-spawning surfaces (poll/discord/
// heartbeat, plus voice-dispatch, which reuses the discord set). Before this module
// each daemon carried its own ALLOWED_TOOLS string
// and SKILL_SRCS array, and runtime.ts hardcoded the union of skill names for the
// learned-skill shadow guard -- app/CLAUDE.md flagged "three allow-rule sources
// that must stay in sync" as a live drift hazard on a security boundary. Defining
// each surface once here, composed from shared pieces, removes it: the tool
// strings are built from a common core, and BAKED_SKILL_NAMES is DERIVED from the
// surface skill lists (so adding a skill to a surface can't leave the guard stale).
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// grants.ts lives in APP_DIR/scripts, so this resolves to APP_DIR.
const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
// Absolute paths to the credential-boundary CLIs. Exported so the daemons
// import them rather than recomputing the same join() -- the path granted in the
// allow-list here and the path a daemon injects into the run's prompt / invokes
// directly MUST be the same string, or a moved file silently breaks the
// `Bash(node <path> *)` grant. One definition removes that drift hazard.
export const MAIL_CLI = join(APP_DIR, "scripts", "mail-cli.ts");
export const DISCORD_CLI = join(APP_DIR, "scripts", "discord-cli.ts");
export const SMS_CLI = join(APP_DIR, "scripts", "sms-cli.ts");
export const CHAT_CLI = join(APP_DIR, "scripts", "chat-cli.ts");

// Tools every surface grants: the offline code sandbox, the workspace read window,
// keyless web fetch, both browsers, native web research, on-demand Skill loading,
// and the (cwd-confined) memory writes. The per-surface CLI grants below prepend.
const CORE_TOOLS =
  "Bash(code-cli *) Bash(files-cli *) Bash(collections-cli *) Bash(memory-cli *) Bash(calendar-cli *) Bash(checklist-cli *) Bash(recipes-cli *) Bash(link-cli *) Bash(data-cli *) Bash(skills-cli *) Bash(web-cli *) Bash(playwright-cli *) Bash(invisible-cli *) WebSearch WebFetch Skill Read Write Edit";

// Per-surface allow-lists. Deliberate asymmetries (unchanged from the old inline
// strings):
//  - mail: mail + schedule-cli (an email run may schedule); NOT discord.
//  - discord: discord + schedule-cli (a chat run may schedule); NOT mail.
//  - heartbeat: mail + discord + sms (a fired task may deliver to any of the
//    three surfaces) but NOT schedule-cli -- a scheduled task must never
//    schedule/cancel tasks.
export const MAIL_TOOLS = `Bash(node ${MAIL_CLI} *) Bash(mail-cli *) Bash(schedule-cli *) ${CORE_TOOLS}`;
export const DISCORD_TOOLS = `Bash(node ${DISCORD_CLI} *) Bash(discord-cli *) Bash(schedule-cli *) ${CORE_TOOLS}`;
export const HEARTBEAT_TOOLS = `Bash(node ${MAIL_CLI} *) Bash(mail-cli *) Bash(node ${DISCORD_CLI} *) Bash(discord-cli *) Bash(node ${SMS_CLI} *) Bash(sms-cli *) ${CORE_TOOLS}`;
// tui: the operator's own terminal (`baxter shell`) -- a trusted trigger, so the
// generous UNION (mail + discord + schedule + core). Still an allowlist, and chat
// runs still go through runAgent -> stripRunSecrets, so the LLM never sees the keys.
export const TUI_TOOLS = `Bash(node ${MAIL_CLI} *) Bash(mail-cli *) Bash(node ${DISCORD_CLI} *) Bash(discord-cli *) Bash(schedule-cli *) ${CORE_TOOLS}`;

// sms: mirrors DISCORD_TOOLS (can schedule and send via sms-cli, access core tools).
// Has no discord-cli tool, so its skill base excludes `discord` -- see SMS_SKILL_NAMES.
export const SMS_TOOLS = `Bash(node ${SMS_CLI} *) Bash(sms-cli *) Bash(schedule-cli *) ${CORE_TOOLS}`;

// chat: mirrors SMS_TOOLS -- can schedule and reply via chat-cli, access core tools.
// No external provider (no creds, no network in chat-cli itself), and -- like sms --
// no discord-cli tool, so its skill base excludes `discord` -- see CHAT_SKILL_NAMES.
export const CHAT_TOOLS = `Bash(node ${CHAT_CLI} *) Bash(chat-cli *) Bash(schedule-cli *) ${CORE_TOOLS}`;

// Skills staged into each run's cwd .claude/skills (see ensureSkills in
// runtime.ts). playwright-cli's skill is generated at BUILD under .claude/skills;
// the rest ship in the repo's skills/. Each surface is a plain name list, resolved
// to source dirs by skillSrcs().
const BUILD_SKILLS_DIR = join(APP_DIR, ".claude", "skills");
const REPO_SKILLS_DIR = join(APP_DIR, "skills");
function skillSrc(name: string): string {
  return join(name === "playwright-cli" ? BUILD_SKILLS_DIR : REPO_SKILLS_DIR, name);
}
function skillSrcs(names: string[]): string[] {
  return names.map(skillSrc);
}

// ONE base skill list -- append new skills HERE (e.g. via `make add-skill`) and
// every surface picks them up, minus its own exclusions below.
export const SKILL_NAMES = ["playwright-cli", "invisible-playwright", "discord", "code", "schedule", "web", "collections", "memory", "calendar", "checklist", "recipes", "links", "data", "skill-discovery", "skill-creator", "help-user-setup", "sms-opt-out"];

// Each surface derives its staged skills by FILTERING the base list. The exclusions
// are the only skill asymmetries, and each mirrors a missing tool so a run never
// carries a doc for a capability it lacks:
//  - mail excludes `discord` (it has no discord-cli tool).
//  - heartbeat excludes `schedule` (no schedule-cli -- a fired task can't schedule).
//  - sms excludes `discord` (no discord-cli tool -- mirrors mail).
//  - discord + voice exclude nothing.
// The tool grants above remain the real, FAIL-CLOSED boundary; these exclusions only
// keep the docs consistent (a staged doc never grants its tool). One base list means
// a skill added there flows to every surface automatically, minus its exclusions.
// NAMES are the ONE place the per-surface exclusions live; the SRCS that ensureSkills
// stages are DERIVED from them -- so the list the prompt advertises ({{LOADED_SKILLS}})
// and the skill dirs actually staged can never drift apart. `make add-skill` (appends to
// SKILL_NAMES) flows to both automatically -- the fix for the prompt list that used to be
// hardcoded and silently missed skill-creator/web/collections/data/skill-discovery.
const skillNamesExcept = (...exclude: string[]): string[] => SKILL_NAMES.filter((n) => !exclude.includes(n));
export const MAIL_SKILL_NAMES = skillNamesExcept("discord");
export const DISCORD_SKILL_NAMES = skillNamesExcept();
export const HEARTBEAT_SKILL_NAMES = skillNamesExcept("schedule");
export const TUI_SKILL_NAMES = skillNamesExcept(); // operator surface: all baked skills
export const SMS_SKILL_NAMES = skillNamesExcept("discord"); // sms excludes `discord` (it has no discord-cli tool, mirrors mail)
export const CHAT_SKILL_NAMES = skillNamesExcept("discord"); // chat excludes `discord` (it has no discord-cli tool, mirrors sms/mail)
export const MAIL_SKILL_SRCS = skillSrcs(MAIL_SKILL_NAMES);
export const DISCORD_SKILL_SRCS = skillSrcs(DISCORD_SKILL_NAMES);
export const HEARTBEAT_SKILL_SRCS = skillSrcs(HEARTBEAT_SKILL_NAMES);
export const TUI_SKILL_SRCS = skillSrcs(TUI_SKILL_NAMES);
export const SMS_SKILL_SRCS = skillSrcs(SMS_SKILL_NAMES);
export const CHAT_SKILL_SRCS = skillSrcs(CHAT_SKILL_NAMES);
// Formats a surface's NAMES for the prompt's "skills already loaded" line.
export const loadedSkillsList = (names: string[]): string => names.map((n) => `\`${n}\``).join(", ");

// The floor for the learned-skill shadow guard: a learned skill may never take one
// of these names (see ensureSkills). The union of the surfaces is exactly the base
// list (each surface is a subset), so derive it from SKILL_NAMES directly -- a skill
// added there is covered automatically and the guard can't silently go stale.
// `basename` so it matches whether the source is under BUILD_SKILLS_DIR or REPO_SKILLS_DIR.
export const BAKED_SKILL_NAMES = new Set(skillSrcs(SKILL_NAMES).map((s) => basename(s)));

// RETIRED skill names -- the Collections-rename tombstone (2026-08-18). `projects`
// used to be a baked skill (the same docs under skills/projects/, pre-rename); it
// left SKILL_NAMES (and therefore BAKED_SKILL_NAMES) when `collections` took its
// place. That alone would RE-OPEN the name: a pre-existing user-authored learned
// skill at learned-skills/projects would stage into .claude/skills/projects and be
// advertised by skillsPreamble -- an active Projects skill surviving the cutover.
// This fixed denylist keeps the retired name refused at both activation points in
// runtime.ts (ensureSkills skips it without staging; skillsPreamble never lists it).
// Deliberately SEPARATE from the derived BAKED_SKILL_NAMES: a retired name is not a
// baked skill, so it must never be staged, advertised, or pruned-protected as one.
// This is retirement enforcement, not an alias -- nothing maps, loads, or executes
// the retired name. A retired name grants no exception to the shadowing rules
// either: `collections` is reserved the normal derived way.
export const RETIRED_SKILL_NAMES = new Set(["projects"]);
