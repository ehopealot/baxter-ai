import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTuiInput,
  resolveSlash,
  SLASH_TOOLS,
  META_COMMANDS,
  renderEvent,
  isFailureReason,
  keyFilesToWrite,
  onboardingHint,
  bothSurfacesUnconfigured,
  stripFrontmatter,
  isBodyTerminator,
  completionContext,
  renderHistory,
} from "./tui-core.mjs";
import { AGENTMAIL_KEY_PATH, DISCORD_TOKEN_PATH } from "./paths.mjs";
import { MAIL_CLI } from "./grants.mjs";

// --- parseTuiInput: classify + tokenize a single REPL line ---

test("parseTuiInput: blank / whitespace -> blank", () => {
  assert.equal(parseTuiInput("").kind, "blank");
  assert.equal(parseTuiInput("   \t ").kind, "blank");
});

test("parseTuiInput: plain text -> chat (trimmed)", () => {
  assert.deepEqual(parseTuiInput("  what's on my list?  "), { kind: "chat", text: "what's on my list?" });
});

test("parseTuiInput: leading // escapes to a chat message that starts with a slash", () => {
  // so you can literally say "/help" to Baxter instead of running the meta command
  assert.deepEqual(parseTuiInput("//help me"), { kind: "chat", text: "/help me" });
});

test("parseTuiInput: /verb args -> slash with argv (quote-aware)", () => {
  assert.deepEqual(parseTuiInput("/projects list"), { kind: "slash", verb: "projects", args: ["list"] });
  assert.deepEqual(parseTuiInput('/web fetch "https://x y/z"'), { kind: "slash", verb: "web", args: ["fetch", "https://x y/z"] });
  assert.deepEqual(parseTuiInput("/exit"), { kind: "slash", verb: "exit", args: [] });
});

test("parseTuiInput: a bare slash is chat, not an empty command", () => {
  assert.equal(parseTuiInput("/").kind, "chat");
});

// --- resolveSlash: the security-critical dispatch (allowlist -> argv, never a shell string) ---

test("resolveSlash: known tool verb -> {type:tool, argv:[cli, ...args]}", () => {
  assert.deepEqual(resolveSlash("projects", ["list"]), { type: "tool", argv: ["projects-cli", "list"] });
  assert.deepEqual(resolveSlash("web", ["fetch", "https://x"]), { type: "tool", argv: ["web-cli", "fetch", "https://x"] });
});

test("resolveSlash: /mail runs `node <MAIL_CLI>` (no shim on PATH for it)", () => {
  assert.deepEqual(resolveSlash("mail", ["list-new"]), { type: "tool", argv: ["node", MAIL_CLI, "list-new"] });
});

test("resolveSlash: /code opens body mode; --file skips it", () => {
  assert.deepEqual(resolveSlash("code", ["python"]), { type: "tool", argv: ["code-cli", "python"], body: true });
  assert.deepEqual(resolveSlash("code", ["node", "--file", "x.js"]), { type: "tool", argv: ["code-cli", "node", "--file", "x.js"], body: false });
});

test("resolveSlash: meta verbs classify as meta, not tools", () => {
  for (const v of ["help", "tools", "memory", "harness", "clear", "exit"]) {
    assert.equal(resolveSlash(v, []).type, "meta", `${v} should be meta`);
  }
  assert.deepEqual(resolveSlash("skill", ["checklist"]), { type: "meta", verb: "skill", args: ["checklist"] });
});

test("resolveSlash: unknown verb -> error, never a command", () => {
  const r = resolveSlash("bogus", []);
  assert.equal(r.type, "error");
  assert.equal(r.argv, undefined);
});

test("resolveSlash: a bare list-type verb defaults to its list subcommand; args suppress it", () => {
  assert.deepEqual(resolveSlash("projects", []), { type: "tool", argv: ["projects-cli", "list"] });
  assert.deepEqual(resolveSlash("schedule", []), { type: "tool", argv: ["schedule-cli", "list"] });
  assert.deepEqual(resolveSlash("files", []), { type: "tool", argv: ["files-cli", "list"] });
  assert.deepEqual(resolveSlash("data", []), { type: "tool", argv: ["data-cli", "list"] });
  assert.deepEqual(resolveSlash("mail", []), { type: "tool", argv: ["node", MAIL_CLI, "list-new"] });
  assert.deepEqual(resolveSlash("discord", []), { type: "tool", argv: ["discord-cli", "list-channels"] });
  // a tool WITHOUT a default (web) stays bare; any args suppress the default
  assert.deepEqual(resolveSlash("web", []), { type: "tool", argv: ["web-cli"] });
  assert.deepEqual(resolveSlash("projects", ["open", "x"]), { type: "tool", argv: ["projects-cli", "open", "x"] });
});

test("resolveSlash: /load_skill and /loadskill alias to the /skill meta command", () => {
  assert.deepEqual(resolveSlash("load_skill", ["checklist"]), { type: "meta", verb: "skill", args: ["checklist"] });
  assert.equal(resolveSlash("loadskill", []).verb, "skill");
});

test("SECURITY: a shell-metachar / injection verb never resolves to an executable command", () => {
  for (const evil of ["rm", "sh", "bash", "code; rm -rf /", "`id`", "$(id)", "web|cat", "../../bin/sh"]) {
    const r = resolveSlash(evil, ["-rf", "/"]);
    assert.equal(r.type, "error", `${evil} must be rejected`);
    assert.equal(r.argv, undefined, `${evil} must not yield an argv`);
  }
  // and every legitimately-resolved tool is spawned as an argv array (no shell string field)
  for (const verb of Object.keys(SLASH_TOOLS)) {
    const r = resolveSlash(verb, ["arg with spaces", "$(evil)", ";rm"]);
    assert.equal(r.type, "tool");
    assert.ok(Array.isArray(r.argv), `${verb} must resolve to an argv array`);
    // args are carried verbatim as separate argv elements -- never concatenated into a string
    assert.ok(r.argv.includes("$(evil)") && r.argv.includes(";rm"), `${verb} args must pass through as literal argv elements`);
    assert.equal(typeof r.command, "undefined", `${verb} must not expose a shell 'command' string`);
  }
});

test("META_COMMANDS and SLASH_TOOLS are disjoint (a verb is one or the other)", () => {
  const tools = new Set(Object.keys(SLASH_TOOLS));
  for (const m of META_COMMANDS) assert.ok(!tools.has(m), `${m} is both meta and tool`);
});

// --- isBodyTerminator: ends /code body collection ---

test("isBodyTerminator: a lone '.' ends the body; other lines don't", () => {
  assert.equal(isBodyTerminator("."), true);
  assert.equal(isBodyTerminator(" . "), true);
  assert.equal(isBodyTerminator("print(1)"), false);
  assert.equal(isBodyTerminator("..."), false);
});

// --- completionContext: what a TAB completes ---

test("completionContext: bare /word completes the verb", () => {
  assert.deepEqual(completionContext("/pro"), { kind: "verb", prefix: "/pro" });
  assert.deepEqual(completionContext("/"), { kind: "verb", prefix: "/" });
});

test("completionContext: chat text (or non-slash) completes nothing", () => {
  assert.equal(completionContext("hello there").kind, "none");
  assert.equal(completionContext("").kind, "none");
});

test("completionContext: /skill <x> (and aliases) completes a skill name", () => {
  assert.deepEqual(completionContext("/skill che"), { kind: "skill", prefix: "che" });
  assert.deepEqual(completionContext("/skill "), { kind: "skill", prefix: "" }); // trailing space -> all
  assert.deepEqual(completionContext("/load_skill x"), { kind: "skill", prefix: "x" });
});

test("completionContext: /projects open|save <x> completes a slug; list/other do not", () => {
  assert.deepEqual(completionContext("/projects open pro"), { kind: "project", prefix: "pro" });
  assert.deepEqual(completionContext("/projects save my"), { kind: "project", prefix: "my" });
  assert.equal(completionContext("/projects list").kind, "none");
  assert.equal(completionContext("/web http").kind, "none");
});

// --- renderHistory: session transcript threaded into the fresh-per-turn prompt ---

test("renderHistory: empty -> '' (caller shows a start-of-session note)", () => {
  assert.equal(renderHistory([]), "");
  assert.equal(renderHistory(undefined), "");
  assert.equal(renderHistory([{ role: "user", text: "  " }]), "", "whitespace-only entries skipped");
});

test("renderHistory: labels operator vs Baxter, oldest-first, blank-line separated", () => {
  const h = [
    { role: "user", text: "which first?" },
    { role: "baxter", text: "model, discord, or email?" },
    { role: "user", text: "2" },
  ];
  assert.equal(renderHistory(h), "Operator: which first?\n\nYou: model, discord, or email?\n\nOperator: 2");
});

test("renderHistory: bounded to the most recent maxChars, oldest dropped first", () => {
  const h = [
    { role: "user", text: "A".repeat(100) },
    { role: "baxter", text: "B".repeat(100) },
    { role: "user", text: "recent" },
  ];
  const out = renderHistory(h, { maxChars: 120 });
  assert.match(out, /recent/, "latest turn kept");
  assert.doesNotMatch(out, /AAAA/, "oldest turn dropped to fit the budget");
});

test("renderHistory: never drops the single most-recent turn even if it exceeds the budget", () => {
  const out = renderHistory([{ role: "user", text: "X".repeat(500) }], { maxChars: 50 });
  assert.match(out, /X{500}/, "the latest turn is always present");
});

// --- renderEvent: pure normalized-event -> terminal line(s) ---

test("renderEvent: text shows Baxter's words", () => {
  assert.match(renderEvent({ kind: "text", text: "hi there" }), /hi there/);
});

test("renderEvent: tool_use includes the cli for {cli,args} (run_cli's name alone doesn't say which)", () => {
  assert.match(renderEvent({ kind: "tool_use", name: "run_cli", input: { cli: "discord-cli", args: ["send", "123", "hi"] } }), /discord-cli/);
});

test("renderEvent: tool_use handles claude's {command} and {file_path} shapes (not just {args})", () => {
  assert.match(renderEvent({ kind: "tool_use", name: "Bash", input: { command: "ls -la /tmp" } }), /ls -la \/tmp/);
  assert.match(renderEvent({ kind: "tool_use", name: "Read", input: { file_path: "/app/memory.md" } }), /\/app\/memory\.md/);
});

test("renderEvent: non-string tool_result content is coerced, never [object Object]", () => {
  // openrouter/local emit an object; claude can emit an array of content blocks
  const obj = renderEvent({ kind: "tool_result", isError: false, content: { ok: true, note: "done" } });
  assert.doesNotMatch(obj, /\[object Object\]/);
  assert.match(obj, /done/);
  const arr = renderEvent({ kind: "tool_result", isError: false, content: [{ type: "text", text: "hello world" }] });
  assert.doesNotMatch(arr, /\[object Object\]/);
  assert.match(arr, /hello world/);
});

test("renderEvent: a huge coerced tool_result is char-capped (JSON is one line -> the line cap can't bound it)", () => {
  const out = renderEvent({ kind: "tool_result", isError: false, content: { output: "x".repeat(50000) } });
  assert.ok(out.length < 5000, `expected char-capped output, got ${out.length}`);
  assert.doesNotMatch(out, /\[object Object\]/);
});

test("renderEvent: long tool_result is truncated with a (+N) marker", () => {
  const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const out = renderEvent({ kind: "tool_result", isError: false, content });
  assert.match(out, /line 0/);
  assert.match(out, /\+\d+/); // a "(+N lines)"-style marker
  assert.ok(out.split("\n").length < 50, "should be truncated");
});

test("renderEvent: an error result renders as an error", () => {
  assert.match(renderEvent({ kind: "tool_result", isError: true, content: "boom" }), /boom/);
});

test("isFailureReason <-> renderEvent stay coupled: renderEvent shows a non-empty line iff isFailureReason (no silent hard-fail)", () => {
  // tui.mjs's `sawError` gate trusts this coupling -- if renderEvent ever returned "" for a
  // failure result, a hard-failed run would go silent. Lock them together.
  for (const sub of ["error", "error_max_turns", "error_during_execution", "cancelled", undefined]) {
    const ev = { kind: "result", subtype: sub, text: "" };
    assert.equal(isFailureReason(ev), true, `${sub} is a failure reason`);
    assert.ok(renderEvent(ev).length > 0, `renderEvent must show a line for a ${sub} result`);
  }
  const ok = { kind: "result", subtype: "success", text: "answer" };
  assert.equal(isFailureReason(ok), false);
  assert.equal(renderEvent(ok), "");
  assert.equal(isFailureReason({ kind: "text", text: "hi" }), false, "non-result events are never a failure reason");
});

test("renderEvent: suppresses a success result (already streamed) but renders an error result", () => {
  // success text duplicates the streamed reply; error text (e.g. graceful context-full,
  // exit 0) never streamed and is the only explanation the operator gets.
  assert.equal(renderEvent({ kind: "result", subtype: "success", text: "the answer" }), "");
  assert.match(renderEvent({ kind: "result", subtype: "error", text: "context full -- didn't fit" }), /context full/);
  // claude's error_max_turns/error_during_execution carry no text -> fall back to the subtype
  assert.match(renderEvent({ kind: "result", subtype: "error_max_turns", text: "" }), /error_max_turns/);
});

// --- keyFilesToWrite: the startup-credential decision (I/O happens in tui.mjs) ---

test("keyFilesToWrite: writes the 0600 fallback files only for env vars that are present", () => {
  // format matches what the daemons write / the CLIs read: JSON {apiKey} / {token}
  assert.deepEqual(keyFilesToWrite({ AGENTMAIL_API_KEY: "k", DISCORD_BOT_TOKEN: "t" }), [
    { path: AGENTMAIL_KEY_PATH, contents: JSON.stringify({ apiKey: "k" }) },
    { path: DISCORD_TOKEN_PATH, contents: JSON.stringify({ token: "t" }) },
  ]);
  assert.deepEqual(keyFilesToWrite({ AGENTMAIL_API_KEY: "k" }), [{ path: AGENTMAIL_KEY_PATH, contents: JSON.stringify({ apiKey: "k" }) }]);
  assert.deepEqual(keyFilesToWrite({}), []);
});

// --- onboardingHint: nudge setup help only when NEITHER surface is configured ---

test("onboardingHint: offers setup help only when both Discord and email are unconfigured", () => {
  const hint = onboardingHint({});                // no skill body -> fallback nudge
  assert.match(hint, /neither Discord nor email configured/);
  assert.match(hint, /help-user-setup/);      // points at the right skill
  assert.match(hint, /don't nag/);            // history-aware, one-shot
  // as soon as EITHER surface is set up, no nudge
  assert.equal(onboardingHint({ DISCORD_BOT_TOKEN: "t" }), "");
  assert.equal(onboardingHint({ AGENTMAIL_API_KEY: "k" }), "");
  assert.equal(onboardingHint({ AGENTMAIL_API_KEY: "k", DISCORD_BOT_TOKEN: "t" }), "");
});

test("onboardingHint: EMBEDS the setup guide inline (no tool needed) when the skill body is passed", () => {
  const md = "---\nname: help-user-setup\ndescription: x\n---\n# Helping a user set Baxter up\nStep one: pick a model.";
  const hint = onboardingHint({}, md);
  assert.match(hint, /<setup-guide>/);
  assert.match(hint, /Step one: pick a model\./);       // body embedded
  assert.doesNotMatch(hint, /name: help-user-setup/);    // frontmatter stripped
  assert.match(hint, /follow it directly and talk them through it/); // embed + talk-through, no tool nudge needed
  assert.equal(onboardingHint({ DISCORD_BOT_TOKEN: "t" }, md), ""); // still gated on unconfigured
});

test("stripFrontmatter: removes a leading --- ... --- block, leaves body (and no-op without one)", () => {
  assert.equal(stripFrontmatter("---\na: 1\n---\nbody here"), "body here");
  assert.equal(stripFrontmatter("no frontmatter"), "no frontmatter");
});

test("bothSurfacesUnconfigured: true only when neither email key nor Discord token is set", () => {
  assert.equal(bothSurfacesUnconfigured({}), true);                              // gates the setup kickoff
  assert.equal(bothSurfacesUnconfigured({ DISCORD_BOT_TOKEN: "t" }), false);
  assert.equal(bothSurfacesUnconfigured({ AGENTMAIL_API_KEY: "k" }), false);
  assert.equal(bothSurfacesUnconfigured({ AGENTMAIL_API_KEY: "k", DISCORD_BOT_TOKEN: "t" }), false);
});
