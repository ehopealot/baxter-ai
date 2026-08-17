// Pure cores for the Baxter TUI (scripts/tui.ts). Dependency-light, with no
// import-time side effects and no writes, so the input parsing, the slash
// allowlist (a SECURITY boundary -- see resolveSlash), the event renderer, the
// startup credential-file decision, and the main-prompt slot map are all
// unit-tested; tui.ts is the thin I/O shell. The one deliberate non-purity is
// mainPromptSlots: its preamble renderers (projects/skills/household) do fresh
// READ-ONLY file reads on each call, same fresh-read contract as every other
// surface -- never writes, never cached.
import { MEMORY_PATH, CREDENTIALS_PATH, LEARNED_SKILLS_DIR, MAIL_KEYS_PATH, DISCORD_TOKEN_PATH } from "./paths.ts";
import { MAIL_CLI, TUI_SKILL_NAMES, loadedSkillsList } from "./grants.ts";
import { skillsPreamble } from "./runtime.ts";
import type { NormalizedEvent } from "./runtime.ts";
import { projectsPreamble } from "./projects-cli.ts";
import { householdPreamble } from "./household.ts";

// A plain env-var bag: matches both NodeJS.ProcessEnv and a plain test object literal.
type EnvBag = Record<string, string | undefined>;

// --- input parsing ---

export type ParsedInput =
  | { kind: "blank" }
  | { kind: "chat"; text: string }
  | { kind: "slash"; verb: string; args: string[] };

// Quote-aware tokenizer: whitespace-split, grouping "double-quoted" runs
// (quotes stripped). NO shell expansion -- tokens stay literal, which is the
// point: resolveSlash hands them to a child as argv, never a shell string, so a
// `$(...)`/`;`/backtick inside an arg is an inert string.
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// Classify one REPL line. `/verb …` is a command; `//x` escapes to a chat
// message that starts with a slash; a bare `/` is chat, not an empty command.
export function parseTuiInput(line: string): ParsedInput {
  const t = line.trim();
  if (t === "") return { kind: "blank" };
  if (t.startsWith("//")) return { kind: "chat", text: t.slice(1) };
  if (t.startsWith("/") && t.length > 1) {
    const [verb, ...args] = tokenize(t.slice(1));
    return { kind: "slash", verb, args };
  }
  return { kind: "chat", text: t };
}

// --- slash dispatch (allowlist -> argv) ---

// verb -> the argv PREFIX of the tool it runs. Mail runs `node <mail-cli.ts>`;
// the PATH shim grant is available to model tool calls.
export const SLASH_TOOLS: Record<string, string[]> = {
  code: ["code-cli"],
  files: ["files-cli"],
  projects: ["projects-cli"],
  data: ["data-cli"],
  skills: ["skills-cli"],
  web: ["web-cli"],
  discord: ["discord-cli"],
  schedule: ["schedule-cli"],
  playwright: ["playwright-cli"],
  invisible: ["invisible-cli"],
  usage: ["usage-cli"],
  mail: ["node", MAIL_CLI],
};

// Handled in-process by tui.ts (read a file, print a table, quit) -- not spawned.
export const META_COMMANDS = new Set(["help", "tools", "memory", "skill", "harness", "clear", "exit"]);

// Aliases -> canonical verb. `load_skill` is the model's own tool name (from the
// harness preamble), a natural thing to type -- map it to the /skill meta command.
export const VERB_ALIASES: Record<string, string> = { load_skill: "skill", loadskill: "skill" };

// A bare `/verb` (no args) defaults to the CLI's "list/show" subcommand, so
// `/projects` lists projects, `/schedule` lists tasks, etc. STATIC values only ->
// no injection surface (they're never derived from user input).
export const SLASH_TOOL_DEFAULT: Record<string, string[]> = {
  files: ["list"],
  projects: ["list"],
  schedule: ["list"],
  data: ["list"],
  usage: ["show"],
  // Inbound dispatch is owned by mail-bot; the TUI only invokes outbound mail.
  mail: ["send"],
  discord: ["list-channels"],
};

export type SlashResolution =
  | { type: "meta"; verb: string; args: string[] }
  | { type: "error"; message: string }
  | { type: "tool"; argv: string[]; body?: boolean };

// Resolve a slash verb to an action. THE SECURITY BOUNDARY: a tool only ever
// resolves to an {argv} array (spawned with NO shell), and only for a verb in
// the static SLASH_TOOLS allowlist; an unknown or metacharacter-laden verb is an
// error, never a command. `hasOwnProperty` (not `in`) so `__proto__`/`constructor`
// can't match a prototype method. Args pass through verbatim as argv elements.
export function resolveSlash(rawVerb: string, args: string[] = []): SlashResolution {
  const verb = Object.prototype.hasOwnProperty.call(VERB_ALIASES, rawVerb) ? VERB_ALIASES[rawVerb] : rawVerb;
  if (META_COMMANDS.has(verb)) return { type: "meta", verb, args };
  if (!Object.prototype.hasOwnProperty.call(SLASH_TOOLS, verb)) {
    return { type: "error", message: `unknown command /${verb}` };
  }
  // No args -> the tool's default "list" subcommand, where it has one (static).
  const effArgs = args.length === 0 && Object.prototype.hasOwnProperty.call(SLASH_TOOL_DEFAULT, verb)
    ? SLASH_TOOL_DEFAULT[verb]
    : args;
  const argv = [...SLASH_TOOLS[verb], ...effArgs];
  // /code reads the program on stdin -> body-collection mode, unless --file is given.
  if (verb === "code") return { type: "tool", argv, body: !args.includes("--file") };
  return { type: "tool", argv };
}

// Ends a /code body-collection block.
export function isBodyTerminator(line: string): boolean {
  return line.trim() === ".";
}

// Render the in-session conversation into a compact transcript for the TUI prompt.
// The shell runs a FRESH agent per turn, so without this Baxter can't see what was
// just said (the "type 2 -> Baxter forgets it offered a numbered menu" gap). history
// is [{role:"user"|"baxter", text}] oldest-first; each turn tui.ts appends the
// operator line + Baxter's reply. Bounded to the most RECENT maxChars so a long
// session can't grow the prompt unboundedly -- oldest whole turns drop first, but the
// latest turn is always kept. Empty/whitespace-only entries are skipped; no history
// -> "" (the caller substitutes a "start of session" note). Pure -> unit-tested.
export interface HistoryEntry {
  role: "user" | "baxter";
  text: string;
}

export function renderHistory(history: HistoryEntry[] | undefined, { maxChars = 6000 }: { maxChars?: number } = {}): string {
  const items = (Array.isArray(history) ? history : []).filter((m) => m && typeof m.text === "string" && m.text.trim());
  const kept: string[] = [];
  let total = 0;
  // Walk newest-first, prepend, stop once adding an older turn would blow the budget
  // (but never drop the single most-recent turn, even if it alone exceeds maxChars).
  for (let i = items.length - 1; i >= 0; i--) {
    const label = items[i].role === "user" ? "Operator" : "You";
    const block = `${label}: ${items[i].text.trim()}`;
    if (kept.length && total + block.length > maxChars) break;
    kept.unshift(block);
    total += block.length + 2; // +2 for the "\n\n" join
  }
  return kept.join("\n\n");
}

// Decide what a TAB at the end of `line` should complete, so tui.ts's completer just
// supplies the candidate pool. Pure/testable. Returns { kind, prefix } where `prefix`
// is the substring readline completes against:
//  - "verb":    the leading `/word` (complete against the known verbs)
//  - "skill":   `/skill <x>` (or its aliases) -> a skill name
//  - "project": `/projects open|save <x>` -> a project slug
//  - "none":    chat text, or a spot with no useful completion
export interface CompletionContext {
  kind: "verb" | "skill" | "project" | "none";
  prefix: string;
}

export function completionContext(line: string): CompletionContext {
  const s = line.replace(/^\s+/, "");
  if (!s.startsWith("/")) return { kind: "none", prefix: "" };
  const tokens = s.split(/\s+/);
  if (tokens.length === 1) return { kind: "verb", prefix: s }; // "/pro" -> verbs
  const raw = tokens[0].slice(1);
  const verb = Object.prototype.hasOwnProperty.call(VERB_ALIASES, raw) ? VERB_ALIASES[raw] : raw;
  const last = tokens[tokens.length - 1];
  if (verb === "skill" && tokens.length === 2) return { kind: "skill", prefix: last };
  if (verb === "projects" && tokens.length === 3 && (tokens[1] === "open" || tokens[1] === "save")) {
    return { kind: "project", prefix: last };
  }
  return { kind: "none", prefix: "" };
}

// --- event rendering (normalized adapter events -> terminal line[s]) ---

const RESULT_MAX_LINES = 12;
// JSON.stringify escapes newlines to `\n` literals, so a coerced object/array is ONE
// line however large -- the line cap can't bound it. Cap the coerced text by CHARS too
// (a run_cli result's `output` is 256 KiB-capped; a claude image Read is multi-MB base64).
const RESULT_MAX_CHARS = 4000;

// A non-success `result` event is the run's failure / graceful-stop REASON. renderEvent
// renders exactly these (and "" for a success result); tui.ts uses the SAME predicate to
// decide whether a reason was shown before printing its terse fallback -- ONE definition
// so the two can't drift into a silent-failure regression (review 57d1468).
export const isFailureReason = (ev: NormalizedEvent): boolean => ev.kind === "result" && ev.subtype !== "success";

// ev is an adapter.parseEvents() event: {kind: "text"|"tool_use"|"tool_result"
// |"result"|"note", …} -- harness-agnostic (claude/openrouter/local all emit it).
export function renderEvent(ev: NormalizedEvent): string {
  switch (ev.kind) {
    case "text":
      return ev.text ?? "";
    case "tool_use": {
      // Harness-agnostic: openrouter/local emit {cli, args} (include the cli -- run_cli's
      // name alone doesn't say WHICH tool ran); claude emits {command}/{file}/etc.
      const i = (ev.input ?? {}) as { args?: unknown; cli?: unknown; command?: unknown; file_path?: unknown; file?: unknown };
      const a = Array.isArray(i.args) ? [i.cli, ...i.args].filter(Boolean).join(" ")
        : typeof i.command === "string" ? i.command          // claude Bash
        : typeof i.file_path === "string" ? i.file_path      // claude Read/Edit/Write
        : typeof i.file === "string" ? i.file
        : "";
      return `  → ${ev.name}${a ? " " + a : ""}`;
    }
    case "tool_result": {
      // Coerce non-string content: openrouter/local content is an object ({ok,...});
      // claude content can be an array of blocks. Bare String() would render either as
      // "[object Object]". Then cap by CHARS (a coerced JSON is one huge line -- the line
      // cap alone can't bound it) before the line cap.
      const raw = ev.content ?? "";
      let text: string = typeof raw === "string" ? raw
        : Array.isArray(raw) ? raw.map((b: unknown) => (typeof b === "string" ? b : (b as { text?: string })?.text ?? JSON.stringify(b))).join("\n")
        : (JSON.stringify(raw) ?? String(raw));
      if (text.length > RESULT_MAX_CHARS) text = text.slice(0, RESULT_MAX_CHARS) + "…";
      const lines = text.split("\n");
      const shown = lines.slice(0, RESULT_MAX_LINES).map((l) => "    " + l);
      if (lines.length > RESULT_MAX_LINES) shown.push(`    …(+${lines.length - RESULT_MAX_LINES} lines)`);
      return (ev.isError ? "    (error)\n" : "") + shown.join("\n");
    }
    case "result":
      // A SUCCESS result's text already streamed as `text` events (echoing it would
      // duplicate the reply). An ERROR result's text never streamed -- e.g. the runners'
      // graceful context-full stop is exit 0, subtype "error", with the only explanation
      // here -- so render errors; fall back to the subtype when even the text is empty
      // (claude's error_max_turns/error_during_execution carry no result text).
      return isFailureReason(ev) ? `  ⏹ ${ev.text || `(${ev.subtype ?? "error"})`}` : "";
    case "note":
      return ev.text ? `  · ${ev.text}` : "";
    default:
      return "";
  }
}

// --- startup credential-file decision (the 0600 write itself is in tui.ts) ---

// True when NEITHER surface is set up (no email key, no Discord token) — the instance
// can only be reached here in the terminal. Same env signals keyFilesToWrite keys on.
export const bothSurfacesUnconfigured = (env: EnvBag): boolean => !env.RESEND_API_KEY && !env.DISCORD_BOT_TOKEN;

// The synthetic opening turn the TUI runs on an INTERACTIVE first launch when nothing is
// configured, so Baxter proactively opens the setup conversation instead of waiting to be
// asked. Kept short and plain: the long menu-eliciting version confused the small local
// onboarding model. The actual steering (lay out the menu first, one step at a time, don't
// rush ahead) lives in onboardingHint, embedded in the same run's prompt.
export const SETUP_KICKOFF = "Let's get set up!";

// Strip a leading YAML frontmatter block (--- ... ---) off a markdown string.
export function stripFrontmatter(md: string): string {
  return String(md).replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

// Onboarding context for the TUI prompt when nothing is configured. If the
// help-user-setup SKILL.md body is passed in (`setupSkillMd`), it's EMBEDDED inline so
// the model can onboard by following it directly -- no `load_skill`/tool call, which a
// weak local model (`baxter shell ollama`) can't do reliably. Without it, falls back to
// a "load the skill" nudge. Empty once either surface is configured. (The interactive
// SETUP_KICKOFF above is what actually starts the conversation.)
export function onboardingHint(env: EnvBag, setupSkillMd = ""): string {
  if (!bothSurfacesUnconfigured(env)) return "";
  const guide = stripFrontmatter(setupSkillMd).trim();
  // Shared opener + menu (ONE source of truth so the two branches can't drift). They differ
  // only in the tail: embed the full guide, or (fallback, when it can't be read) walk from
  // general knowledge. Tool-free either way -- never tell the model to load a skill
  // (onboarding has no tools).
  const menu = [
    "only be reached here in the terminal. Give your operator the short menu of options first",
    "-- the three areas are your model/brain, Discord, and email -- then walk whichever they",
    "pick one step at a time. Don't dump everything at once, and don't nag if they'd rather do",
    "something else.",
  ];
  const tail = guide
    ? ["", "The full setup guide is embedded below -- follow it directly and talk them through it.", "", "<setup-guide>", guide, "</setup-guide>"]
    : ["", "You don't have the detailed guide this run, so walk them through it from what you know."];
  return [
    "## Getting set up",
    "",
    "This instance has **neither Discord nor email configured yet** -- right now you can",
    ...menu,
    ...tail,
    "",
    "",
  ].join("\n");
}

// runAgent strips these secrets from the chat-run env; mail-cli/discord-cli fall
// back to these 0600 files. Emit exactly the daemons' JSON format so the CLIs
// read them the same way (see mail-bot.ts / discord-bot.ts / heartbeat.ts).
export interface KeyFileToWrite {
  path: string;
  contents: string;
}

export function keyFilesToWrite(env: EnvBag): KeyFileToWrite[] {
  const out: KeyFileToWrite[] = [];
  if (env.RESEND_API_KEY) out.push({ path: MAIL_KEYS_PATH, contents: JSON.stringify({ apiKey: env.RESEND_API_KEY }) });
  if (env.DISCORD_BOT_TOKEN) out.push({ path: DISCORD_TOKEN_PATH, contents: JSON.stringify({ token: env.DISCORD_BOT_TOKEN }) });
  return out;
}

// --- the TUI main-prompt slot map (moved out of tui.ts's renderChatPrompt so the fill is unit-testable) ---

// Today's renderChatPrompt slots, verbatim, plus HOUSEHOLD. tui.ts stays the thin
// I/O shell: readFileSync(PROMPT_PATH) + fillTemplate(template, mainPromptSlots(...)).
// env defaults to process.env (the param lets callers pin PERSONA_NAME/onboarding state);
// householdPreamble() deliberately reads ambient env, same as every other surface's wiring.
export function mainPromptSlots(
  message: string,
  history: HistoryEntry[],
  setupSkillMd: string,
  env: EnvBag = process.env,
): Record<string, string> {
  return {
    PERSONA_NAME: env.PERSONA_NAME || "Baxter",
    MESSAGE: message,
    HISTORY: renderHistory(history) || "(the start of this session)",
    MEMORY_PATH,
    CREDENTIALS_PATH,
    LEARNED_SKILLS_DIR,
    // Injection-safe (slug + date only) -- see projectsPreamble.
    PROJECTS_LIST: projectsPreamble(),
    // Static list of this surface's baked skills (from grants.ts) -- see loadedSkillsList.
    LOADED_SKILLS: loadedSkillsList(TUI_SKILL_NAMES),
    // Injection-safe (learned-skill NAMES only, sanitized) -- see skillsPreamble.
    LEARNED_SKILLS_LIST: skillsPreamble(),
    ONBOARDING_HINT: onboardingHint(env, setupSkillMd),
    // Injection-safe (admitted addresses only, sanitized names) -- see householdPreamble.
    HOUSEHOLD: householdPreamble(),
  };
}
