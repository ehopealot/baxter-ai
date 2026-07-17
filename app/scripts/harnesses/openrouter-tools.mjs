// Security-critical, SDK-independent tool logic for the OpenRouter runner. Kept
// SEPARATE from openrouter-runner.mjs (which wires these into @openrouter/agent's
// tool() + callModel) so the enforced boundary -- the CLI allowlist and the cwd
// confinement -- is unit-testable without the SDK or a live API key. The runner
// emits tool_use/tool_result events around these; the executors themselves are
// pure (params, ctx) -> result, which is what the tests exercise.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, sep, basename, extname, join } from "node:path";

// Tokenize a Claude `--allowedTools` string, keeping `Bash(...)` groups intact
// (they contain spaces) and treating every other run of non-space as one token.
export function tokenizeAllowedTools(s) {
  const out = [];
  const re = /Bash\([^)]*\)|\S+/g;
  let m;
  while ((m = re.exec(s || "")) !== null) out.push(m[0]);
  return out;
}

const NATIVE_TOOLS = new Set(["Read", "Write", "Edit", "Skill", "WebFetch", "WebSearch"]);

// Turn the allowedTools string into what the runner ENFORCES: a map of runnable
// CLIs (friendlyName -> { command, prefixArgs }) and the set of granted native
// tools. Only `Bash(<cmd> *)` patterns become runnable CLIs; a `Bash(node <path>
// *)` (how gmail.mjs is granted, by absolute path) maps a friendly name (the
// file's basename without extension) to `node <path>`, so the model calls
// run_cli({ cli: "gmail", ... }) without knowing the path. Anything the model
// asks to run that isn't in this map is refused -- this is the whole boundary.
export function parseAllowedTools(allowedTools) {
  const cliMap = {};
  const native = new Set();
  for (const tok of tokenizeAllowedTools(allowedTools)) {
    const bash = tok.match(/^Bash\((.+)\)$/);
    if (bash) {
      const pattern = bash[1].trim().replace(/\s*\*\s*$/, "").trim(); // drop trailing wildcard
      const parts = pattern.split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      if (parts[0] === "node" && parts[1]) {
        const name = basename(parts[1], extname(parts[1]));
        cliMap[name] = { command: "node", prefixArgs: [parts[1]] };
      } else {
        cliMap[parts[0]] = { command: parts[0], prefixArgs: parts.slice(1) };
      }
    } else if (NATIVE_TOOLS.has(tok)) {
      native.add(tok);
    }
  }
  return { cliMap, native };
}

// Resolve a model-supplied path against the run's cwd and REFUSE anything that
// escapes it (`..`, absolute paths elsewhere, symlink-y `/etc/...`). read/write/
// edit all go through this, so the run can only touch its own workspace -- the
// token file (outside cwd) stays unreadable, stricter than the Claude path.
export function resolveInCwd(cwd, p) {
  const base = resolve(cwd);
  const abs = resolve(base, String(p ?? ""));
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`path escapes the working directory: ${p}`);
  }
  return abs;
}

// Like resolveInCwd, but ALSO refuses `<cwd>/.claude/` -- for WRITE paths only.
// Claude Code denies a run writing its own `.claude/skills/`; without the same
// guard a run could write_file(".claude/skills/discord/SKILL.md", ...) and
// load_skill("discord") in the SAME run, feeding itself attacker-authored
// "trusted" skill text and bypassing the BAKED_SKILL_NAMES shadow guard that
// ensureSkills enforces on the legitimate learned-skills/ path. Reads (read_file
// / load_skill) still use resolveInCwd, so reading `.claude/` stays fine.
export function resolveWritableInCwd(cwd, p) {
  const abs = resolveInCwd(cwd, p);
  const claudeDir = resolve(cwd, ".claude");
  if (abs === claudeDir || abs.startsWith(claudeDir + sep)) {
    throw new Error(".claude/ is read-only to the run; author skills under learned-skills/ instead");
  }
  return abs;
}

// Spawn a CLI with NO shell (so nothing the model puts in args can inject another
// command) and an optional stdin body. Never rejects: a nonzero exit / timeout /
// spawn error comes back as a structured result the model can read and react to.
function spawnCli(command, args, { cwd, env, input, timeoutMs, maxBytes }) {
  return new Promise((res) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"] });
    } catch (e) {
      return res({ ok: false, error: `spawn failed: ${e.message}` });
    }
    let out = "";
    let err = "";
    let overflow = false;
    let timedOut = false;
    const cap = (s, chunk) => {
      if (s.length >= maxBytes) { overflow = true; return s; }
      return (s + chunk).slice(0, maxBytes);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { out = cap(out, d); });
    child.stderr.on("data", (d) => { err = cap(err, d); });
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs) : null;
    child.on("error", (e) => { if (timer) clearTimeout(timer); res({ ok: false, error: `spawn failed: ${e.message}` }); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return res({ ok: false, error: `timed out after ${timeoutMs}ms`, stdout: out, stderr: err });
      res({ ok: code === 0, exitCode: code, stdout: out, stderr: err, ...(overflow ? { truncated: true } : {}) });
    });
    if (input != null) { child.stdin.on("error", () => {}); child.stdin.end(input); }
  });
}

// --- executors: (params, ctx) -> result. ctx = { cwd, cliMap, env, timeoutMs, maxBytes } ---

export async function runCli({ cli, args = [], stdin }, ctx) {
  const entry = ctx.cliMap[cli];
  if (!entry) {
    const allowed = Object.keys(ctx.cliMap).join(", ") || "(none)";
    return { ok: false, error: `cli "${cli}" is not allowed. Allowed CLIs: ${allowed}.` };
  }
  const argv = [...entry.prefixArgs, ...(Array.isArray(args) ? args : []).map(String)];
  return spawnCli(entry.command, argv, {
    cwd: ctx.cwd,
    env: ctx.env,
    input: stdin != null ? String(stdin) : undefined,
    timeoutMs: ctx.timeoutMs,
    maxBytes: ctx.maxBytes,
  });
}

export function readFile({ path }, ctx) {
  try {
    const abs = resolveInCwd(ctx.cwd, path);
    return { ok: true, content: readFileSync(abs, "utf8") };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function writeFile({ path, content }, ctx) {
  try {
    const abs = resolveWritableInCwd(ctx.cwd, path);
    writeFileSync(abs, String(content ?? ""));
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function editFile({ path, old_string, new_string }, ctx) {
  try {
    const abs = resolveWritableInCwd(ctx.cwd, path);
    const cur = readFileSync(abs, "utf8");
    if (old_string == null || !cur.includes(old_string)) {
      return { ok: false, error: "old_string not found in file (must match exactly)" };
    }
    if (cur.indexOf(old_string) !== cur.lastIndexOf(old_string)) {
      return { ok: false, error: "old_string is not unique in the file; include more surrounding context" };
    }
    writeFileSync(abs, cur.replace(old_string, String(new_string ?? "")));
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function loadSkill({ name }, ctx) {
  try {
    const safe = basename(String(name ?? "")); // no path traversal in the skill name
    const abs = resolveInCwd(ctx.cwd, join(".claude", "skills", safe, "SKILL.md"));
    return { ok: true, name: safe, content: readFileSync(abs, "utf8") };
  } catch (e) {
    return { ok: false, error: `skill "${name}" not found or unreadable: ${e.message}` };
  }
}
