// Pure cores for the Baxter TUI (scripts/tui.mjs). Dependency-light and
// side-effect-free so the input parsing, the slash allowlist (a SECURITY
// boundary -- see resolveSlash), the event renderer, and the startup
// credential-file decision are all unit-tested; tui.mjs is the thin I/O shell.
import { AGENTMAIL_KEY_PATH, DISCORD_TOKEN_PATH } from "./paths.mjs";
import { MAIL_CLI } from "./grants.mjs";

// --- input parsing ---

// Quote-aware tokenizer: whitespace-split, grouping "double-quoted" runs
// (quotes stripped). NO shell expansion -- tokens stay literal, which is the
// point: resolveSlash hands them to a child as argv, never a shell string, so a
// `$(...)`/`;`/backtick inside an arg is an inert string.
function tokenize(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// Classify one REPL line. `/verb …` is a command; `//x` escapes to a chat
// message that starts with a slash; a bare `/` is chat, not an empty command.
export function parseTuiInput(line) {
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

// verb -> the argv PREFIX of the tool it runs. All PATH-installed CLI shims
// except `mail`, which runs `node <mail.mjs>` (no shim on PATH for it).
export const SLASH_TOOLS = {
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
  mail: ["node", MAIL_CLI],
};

// Handled in-process by tui.mjs (read a file, print a table, quit) -- not spawned.
export const META_COMMANDS = new Set(["help", "tools", "memory", "skill", "harness", "clear", "exit"]);

// Resolve a slash verb to an action. THE SECURITY BOUNDARY: a tool only ever
// resolves to an {argv} array (spawned with NO shell), and only for a verb in
// the static SLASH_TOOLS allowlist; an unknown or metacharacter-laden verb is an
// error, never a command. `hasOwnProperty` (not `in`) so `__proto__`/`constructor`
// can't match a prototype method. Args pass through verbatim as argv elements.
export function resolveSlash(verb, args = []) {
  if (META_COMMANDS.has(verb)) return { type: "meta", verb, args };
  if (!Object.prototype.hasOwnProperty.call(SLASH_TOOLS, verb)) {
    return { type: "error", message: `unknown command /${verb}` };
  }
  const argv = [...SLASH_TOOLS[verb], ...args];
  // /code reads the program on stdin -> body-collection mode, unless --file is given.
  if (verb === "code") return { type: "tool", argv, body: !args.includes("--file") };
  return { type: "tool", argv };
}

// Ends a /code body-collection block.
export function isBodyTerminator(line) {
  return line.trim() === ".";
}

// --- event rendering (normalized adapter events -> terminal line[s]) ---

const RESULT_MAX_LINES = 12;
// JSON.stringify escapes newlines to `\n` literals, so a coerced object/array is ONE
// line however large -- the line cap can't bound it. Cap the coerced text by CHARS too
// (a run_cli result's `output` is 256 KiB-capped; a claude image Read is multi-MB base64).
const RESULT_MAX_CHARS = 4000;

// ev is an adapter.parseEvents() event: {kind: "text"|"tool_use"|"tool_result"
// |"result"|"note", …} -- harness-agnostic (claude/openrouter/local all emit it).
export function renderEvent(ev) {
  switch (ev.kind) {
    case "text":
      return ev.text ?? "";
    case "tool_use": {
      // Harness-agnostic: openrouter/local emit {cli, args} (include the cli -- run_cli's
      // name alone doesn't say WHICH tool ran); claude emits {command}/{file}/etc.
      const i = ev.input ?? {};
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
      let text = typeof raw === "string" ? raw
        : Array.isArray(raw) ? raw.map((b) => (typeof b === "string" ? b : b?.text ?? JSON.stringify(b))).join("\n")
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
      return ev.subtype === "success" ? "" : `  ⏹ ${ev.text || `(${ev.subtype ?? "error"})`}`;
    case "note":
      return ev.text ? `  · ${ev.text}` : "";
    default:
      return "";
  }
}

// --- startup credential-file decision (the 0600 write itself is in tui.mjs) ---

// runAgent strips these secrets from the chat-run env; mail.mjs/discord-cli fall
// back to these 0600 files. Emit exactly the daemons' JSON format so the CLIs
// read them the same way (see poll.mjs / discord-bot.mjs / heartbeat.mjs).
export function keyFilesToWrite(env) {
  const out = [];
  if (env.AGENTMAIL_API_KEY) out.push({ path: AGENTMAIL_KEY_PATH, contents: JSON.stringify({ apiKey: env.AGENTMAIL_API_KEY }) });
  if (env.DISCORD_BOT_TOKEN) out.push({ path: DISCORD_TOKEN_PATH, contents: JSON.stringify({ token: env.DISCORD_BOT_TOKEN }) });
  return out;
}
