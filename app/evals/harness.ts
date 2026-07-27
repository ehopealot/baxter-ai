// @ts-nocheck -- TS migration bridge (2026-07-27); this file is not yet typed. Remove this line and drive `tsc --noEmit` green for it in its cluster task. See docs/superpowers/plans/2026-07-27-typescript-migration.md
// The eval run driver. Impure orchestration (temp cwd, mockbin, runAgent) plus a
// handful of PURE pieces (allowedToolsFor / doctorTools / buildSlots /
// renderScenarioPrompt / passThreshold / formatTable) that are unit-tested offline.
//
// A run is hermetic EXCEPT the model call (that's what we're testing): a throwaway
// cwd + a mockbin/ shadowing every mockable CLI + doctored allowedTools so the
// openrouter runner resolves those CLIs via PATH (→ the mocks), never the real ones.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, fillTemplate, getHarness } from "../scripts/runtime.ts";
import { DISCORD_TOOLS, HEARTBEAT_TOOLS, MAIL_TOOLS, MAIL_CLI } from "../scripts/grants.ts";
import { captureFromEvents, runAssertions } from "./assertions.ts";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = dirname(EVAL_DIR); // evals/ -> app/
const MOCK_HANDLER = join(EVAL_DIR, "mock.ts");

// CLIs the mockbin shadows on PATH (the PATH-friendly grants; absolute `node <path>`
// grants are stripped by doctorTools so these PATH forms win).
const MOCK_CLIS = [
  "discord-cli", "mail", "schedule-cli", "code-cli", "files-cli", "projects-cli",
  "data-cli", "skills-cli", "web-cli", "playwright-cli", "invisible-cli",
];

// Per-surface config: the real template + tool grant, and slot defaults (paths under
// the throwaway cwd so the model's cwd-confined read_file can reach the seeded files).
const SURFACES = {
  discord: {
    template: "discord-prompt.md",
    tools: DISCORD_TOOLS,
    defaults: (cwd) => ({
      PERSONA_NAME: "Baxter", BOT_USER: "Baxter#0001", SELF_ID: "999000",
      CHANNEL_ID: "chan1", CHANNEL_KIND: "a text channel",
      TRIGGER_AUTHOR: "erik", TRIGGER_MESSAGE_ID: "msg1",
      HISTORY: "(no earlier messages)",
      LOADED_SKILLS: "discord, code, web, data, projects, schedule",
      PROJECTS_LIST: "(none yet)", LEARNED_SKILLS_LIST: "(none yet)",
      MEMORY_PATH: join(cwd, "memory.md"),
      CREDENTIALS_PATH: join(cwd, "CREDENTIALS.md"),
      CHANNEL_MEMORY_PATH: join(cwd, "channel-memory.md"),
      LEARNED_SKILLS_DIR: join(cwd, "learned-skills"),
    }),
  },
  mail: {
    template: "prompt.md",
    tools: MAIL_TOOLS,
    defaults: (cwd) => ({
      PERSONA_NAME: "Baxter", BAXTER_EMAIL: "baxter@baxter.test",
      FROM: "Erik <erik@example.com>", SUBJECT: "(no subject)", BODY: "",
      MESSAGE_ID: "<msg1@example.com>",
      LOADED_SKILLS: "code, web, data, projects, schedule",
      PROJECTS_LIST: "(none yet)", LEARNED_SKILLS_LIST: "(none yet)",
      MEMORY_PATH: join(cwd, "memory.md"),
      CREDENTIALS_PATH: join(cwd, "CREDENTIALS.md"),
      MAIL_CLI_PATH: MAIL_CLI, // prompt text; the run translates `node <this> reply` -> run_cli mail (mocked)
    }),
  },
  heartbeat: {
    template: "heartbeat-prompt.md",
    tools: HEARTBEAT_TOOLS,
    defaults: (cwd) => ({
      PERSONA_NAME: "Baxter", TASK: "", DELIVER: "post the result to Discord channel chan1",
      LOADED_SKILLS: "discord, code, web, data, projects",
      PROJECTS_LIST: "(none yet)", LEARNED_SKILLS_LIST: "(none yet)",
      MEMORY_PATH: join(cwd, "memory.md"),
      MAIL_CLI_PATH: MAIL_CLI, // the model shouldn't use it; a heartbeat run has no schedule-cli
    }),
  },
};

// --- PURE pieces (unit-tested) ----------------------------------------------

// CONVERT the absolute `Bash(node <path>.ts *)` credential-CLI grants to their
// PATH-friendly `Bash(<basename> *)` form. Two reasons: (1) the openrouter runner's
// parseAllowedTools is first-grant-wins and the absolute grant precedes any friendly
// `Bash(discord-cli *)`, so the friendly name would otherwise resolve to the REAL
// cli; (2) `node <mail.ts>` has NO friendly grant, so we'd lose mail entirely by
// stripping. The basename ("mail", "discord-cli") is exactly the friendly name
// parseAllowedTools derives, so both now resolve via PATH -> mockbin. Dedup so a
// converted grant doesn't duplicate an existing friendly one.
export function doctorTools(tools) {
  const converted = String(tools).replace(/Bash\(node (\S+) \*\)/g, (_, p) => `Bash(${basename(p, extname(p))} *)`);
  // Tokenize keeping `Bash(... *)` groups intact (they contain a space), then dedup.
  const toks = converted.match(/Bash\([^)]*\)|\S+/g) || [];
  const seen = new Set();
  return toks.filter((t) => (seen.has(t) ? false : (seen.add(t), true))).join(" ");
}

export function allowedToolsFor(surface) {
  const s = SURFACES[surface];
  if (!s) throw new Error(`unknown eval surface "${surface}" (have: ${Object.keys(SURFACES).join(", ")})`);
  return doctorTools(s.tools);
}

// Surface defaults + cwd-derived paths, then the scenario's own slots (which win).
export function buildSlots(surface, scenario, cwd) {
  const s = SURFACES[surface];
  if (!s) throw new Error(`unknown eval surface "${surface}"`);
  return { ...s.defaults(cwd), ...(scenario.slots || {}) };
}

// Render the REAL prompt template; throw if any {{SLOT}} was left unfilled (a
// literal {{X}} in the model's prompt is a bug we want loud, not silent).
export function renderScenarioPrompt(surface, scenario, cwd) {
  const s = SURFACES[surface];
  if (!s) throw new Error(`unknown eval surface "${surface}"`);
  const template = readFileSync(join(APP_DIR, s.template), "utf8");
  const prompt = fillTemplate(template, buildSlots(surface, scenario, cwd));
  const missing = [...new Set([...prompt.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))];
  if (missing.length) throw new Error(`unfilled prompt slots for ${surface}: ${missing.join(", ")}`);
  return prompt;
}

// A scenario passes iff at least ceil(ratio*samples) of its samples passed.
export function passThreshold(passes, samples, ratio = 2 / 3) {
  return samples > 0 && passes >= Math.ceil(ratio * samples);
}

export function formatTable(rows) {
  const lines = rows.map((r) => {
    const mark = r.pass ? "PASS" : "FAIL";
    return `  [${mark}] ${r.name}  (${r.passes}/${r.samples})`;
  });
  const passed = rows.filter((r) => r.pass).length;
  lines.push("", `  ${passed}/${rows.length} scenarios passed`);
  return lines.join("\n");
}

// --- impure driver ----------------------------------------------------------

// Build a throwaway mockbin/ shadowing every MOCK_CLIS entry -> the committed handler.
function makeMockbin(dir) {
  mkdirSync(dir, { recursive: true });
  for (const cli of MOCK_CLIS) {
    const shim = `#!/usr/bin/env node\nimport { runMock } from ${JSON.stringify(MOCK_HANDLER)};\nrunMock(${JSON.stringify(cli)});\n`;
    const p = join(dir, cli);
    writeFileSync(p, shim);
    chmodSync(p, 0o755);
  }
}

// Run one sample: fresh cwd, seed, mockbin+canned table, render, runAgent, capture.
// `onEvent` (optional) forwards each normalized runAgent event live (for progress).
async function runSample(surface, scenario, { model, harness, onEvent }) {
  const cwd = mkdtempSync(join(tmpdir(), "baxeval-"));
  try {
    const seed = scenario.seed || {};
    writeFileSync(join(cwd, "memory.md"), seed.memory ?? "");
    writeFileSync(join(cwd, "channel-memory.md"), seed.channelMemory ?? "");
    writeFileSync(join(cwd, "CREDENTIALS.md"), seed.credentials ?? "");
    mkdirSync(join(cwd, "learned-skills"), { recursive: true });
    const mockbin = join(cwd, "mockbin");
    makeMockbin(mockbin);
    const tablePath = join(cwd, "mocks.json");
    writeFileSync(tablePath, JSON.stringify(scenario.mocks || {}));

    const prompt = renderScenarioPrompt(surface, scenario, cwd);
    const env = {
      ...process.env,
      HOME: cwd, // any homedir-derived path (schedule/state) lands in the throwaway
      PATH: `${mockbin}:${process.env.PATH}`,
      EVAL_MOCK_TABLE: tablePath,
      BAXTER_HARNESS: harness,
      OPENROUTER_MODEL: model,
      BAXTER_MODEL_OVERRIDE: "", // don't let a stray media-route override the eval model
    };
    const events = [];
    await runAgent({
      prompt, logId: "eval", cwd, model, harness: getHarness(harness), // runAgent wants the adapter OBJECT
      allowedTools: allowedToolsFor(surface), runsDir: cwd, receivedAt: Date.now(),
      env, onEvent: (ev) => { events.push(ev); onEvent?.(ev); }, logEvents: false, quiet: true,
    });
    return captureFromEvents(events);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// Run a scenario K times; a sample passes iff all its assertions pass. Optional live-
// progress hooks: `onSampleStart({i,K})` before each sample, `onEvent(ev)` for every
// tool call/turn as it happens, `onSample({i,K,pass})` when the sample resolves.
export async function runScenario(scenario, { model, harness, samples = 3, onSampleStart, onEvent, onSample } = {}) {
  const K = scenario.samples ?? samples;
  const sampleResults = [];
  for (let i = 0; i < K; i++) {
    let capture, checks, pass;
    onSampleStart?.({ i, K });
    try {
      capture = await runSample(scenario.surface, scenario, { model, harness, onEvent });
      ({ pass, checks } = runAssertions(capture, scenario.expect || []));
    } catch (e) {
      pass = false; checks = [{ pass: false, why: `run threw: ${e.message}` }];
    }
    sampleResults.push({ pass, checks });
    onSample?.({ i, K, pass });
  }
  const passes = sampleResults.filter((r) => r.pass).length;
  return { name: scenario.name, samples: K, passes, pass: passThreshold(passes, K), sampleResults };
}

// `onScenarioStart(scenario, idx, total)` / `onScenarioDone(row, idx, total)` (both
// optional) let a caller print live status; a real run is 3 slow model calls per
// scenario, so silence for the whole suite is a bad experience. All the print logic
// lives in the caller (run.ts) -- the harness only emits the events.
export async function runSuite(scenarios, opts = {}) {
  const { onScenarioStart, onScenarioDone } = opts;
  const rows = [];
  for (let i = 0; i < scenarios.length; i++) {
    const sc = scenarios[i];
    onScenarioStart?.(sc, i, scenarios.length);
    const row = await runScenario(sc, opts); // opts carries onSample through
    onScenarioDone?.(row, i, scenarios.length);
    rows.push(row);
  }
  return { rows, pass: rows.every((r) => r.pass), table: formatTable(rows) };
}
