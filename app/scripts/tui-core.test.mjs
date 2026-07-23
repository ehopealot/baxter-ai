import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTuiInput,
  resolveSlash,
  SLASH_TOOLS,
  META_COMMANDS,
  renderEvent,
  keyFilesToWrite,
  isBodyTerminator,
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
