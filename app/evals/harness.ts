// The eval run driver. Impure orchestration (temp cwd, mockbin, runAgent) plus a
// handful of PURE pieces (allowedToolsFor / doctorTools / buildSlots /
// renderScenarioPrompt / passThreshold / formatTable) that are unit-tested offline.
//
// A run is hermetic EXCEPT the model call (that's what we're testing): a throwaway
// cwd + a mockbin/ shadowing every mockable CLI + doctored allowedTools so the
// openrouter runner resolves those CLIs via PATH (→ the mocks), never the real ones.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedEvent } from "../scripts/runtime.ts";
import { runAgent, fillTemplate, getHarness, ensureSkills } from "../scripts/runtime.ts";
import {
  DISCORD_TOOLS, HEARTBEAT_TOOLS, MAIL_TOOLS, SMS_TOOLS, CHAT_TOOLS, MAIL_CLI,
  DISCORD_SKILL_SRCS, HEARTBEAT_SKILL_SRCS, MAIL_SKILL_SRCS, SMS_SKILL_SRCS, CHAT_SKILL_SRCS,
} from "../scripts/grants.ts";
import type { Assertion, AssertionResult } from "./assertions.ts";
import { captureFromEvents, runAssertions } from "./assertions.ts";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = dirname(EVAL_DIR); // evals/ -> app/
const MOCK_HANDLER = join(EVAL_DIR, "mock.ts");

// runAgent's usage metering (recordUsage) runs in THIS parent process, whose HOME
// is the real homedir -- the eval's per-scenario HOME=cwd only isolates the child.
// Without this, `make eval` on the box would append eval rows to the tenant's real
// ~/.mail-agent/usage ledger, counting toward its soft cap and skewing the report.
// Redirect metering to a throwaway dir (respecting an externally-set override).
process.env.USAGE_DIR_OVERRIDE ||= mkdtempSync(join(tmpdir(), "eval-usage-"));

// CLIs the mockbin shadows on PATH (the PATH-friendly grants; absolute `node <path>`
// grants are stripped by doctorTools so these PATH forms win).
export const MOCK_CLIS = [
  "discord-cli", "mail-cli", "schedule-cli", "code-cli", "files-cli", "collections-cli", "checklist-cli",
  "data-cli", "skills-cli", "web-cli", "playwright-cli", "invisible-cli", "followup-cli", "sms-cli", "chat-cli",
];

// The five prompt surfaces a scenario can target.
export type Surface = "discord" | "mail" | "heartbeat" | "sms" | "chat";

// The shape every `scenarios/NN-*.ts` file default-exports, and what harness.ts /
// run.ts consume. `mocks` maps a CLI name to either a flat canned response or a
// per-subcommand table (with an optional "*" fallback) -- see mock.ts.
export interface Scenario {
  name: string;
  surface: Surface;
  slots?: Record<string, string>;
  seed?: { memory?: string; channelMemory?: string; credentials?: string };
  mocks?: Record<string, string | Record<string, string>>;
  expect?: Assertion[];
  samples?: number;
}

// One sample's assertion outcomes, folded into a scenario's row.
export interface SampleResult {
  pass: boolean;
  checks: AssertionResult[];
}

// A scenario's aggregated result over its K samples -- what runScenario/runSuite
// return and formatTable renders.
export interface ScenarioRow {
  name: string;
  samples: number;
  passes: number;
  pass: boolean;
  sampleResults: SampleResult[];
}

interface SurfaceConfig {
  template: string;
  tools: string;
  skills: string[];
  defaults: (cwd: string) => Record<string, string>;
}

// Per-surface config: the real template + tool grant, and slot defaults (paths under
// the throwaway cwd so the model's cwd-confined read_file can reach the seeded files).
const SURFACES: Record<Surface, SurfaceConfig> = {
  discord: {
    template: "discord-prompt.md",
    tools: DISCORD_TOOLS,
    skills: DISCORD_SKILL_SRCS,
    defaults: (cwd) => ({
      PERSONA_NAME: "Baxter", BOT_USER: "Baxter#0001", SELF_ID: "999000",
      CHANNEL_ID: "chan1", CHANNEL_KIND: "a text channel",
      TRIGGER_AUTHOR: "erik", TRIGGER_MESSAGE_ID: "msg1",
      HISTORY: "(no earlier messages)",
      LOADED_SKILLS: "discord, code, web, data, collections, schedule",
      COLLECTIONS_LIST: "(none yet)", LEARNED_SKILLS_LIST: "(none yet)",
      MEMORY_PATH: join(cwd, "memory.md"),
      CREDENTIALS_PATH: join(cwd, "CREDENTIALS.md"),
      CHANNEL_MEMORY_PATH: join(cwd, "channel-memory.md"),
      LEARNED_SKILLS_DIR: join(cwd, "learned-skills"),
    }),
  },
  mail: {
    template: "prompt.md",
    tools: MAIL_TOOLS,
    skills: MAIL_SKILL_SRCS,
    defaults: (cwd) => ({
      PERSONA_NAME: "Baxter", BAXTER_EMAIL: "baxter@baxter.test",
      FROM: "Erik <erik@example.com>", SUBJECT: "(no subject)", BODY: "",
      ATTACHMENTS: "",
      MESSAGE_ID: "<msg1@example.com>", THREAD_ID: "thread1", EMAIL_ID: "re_eval",
      LOADED_SKILLS: "code, web, data, collections, schedule",
      COLLECTIONS_LIST: "(none yet)", LEARNED_SKILLS_LIST: "(none yet)",
      MEMORY_PATH: join(cwd, "memory.md"),
      CREDENTIALS_PATH: join(cwd, "CREDENTIALS.md"),
      MAIL_CLI_PATH: MAIL_CLI, // prompt text; the run translates `node <this> reply` -> run_cli mail-cli (mocked)
    }),
  },
  sms: {
    template: "sms-prompt.md",
    tools: SMS_TOOLS,
    skills: SMS_SKILL_SRCS,
    defaults: (cwd) => ({
      PERSONA_NAME: "Baxter", CONVO_DESC: "This is a direct SMS conversation with +15551234567. ", GROUP_NOTE: "",
      HISTORY: "The person: hello", HOUSEHOLD: "- Erik — SMS +15551234567", MORNING_HANDOFF: "", INTRO_NOTE: "",
      LOADED_SKILLS: "code, web, data, collections, schedule, proactive-follow-up",
      COLLECTIONS_LIST: "(none yet)", LEARNED_SKILLS_LIST: "(none yet)",
      MEMORY_PATH: join(cwd, "memory.md"), CREDENTIALS_PATH: join(cwd, "CREDENTIALS.md"),
      LEARNED_SKILLS_DIR: join(cwd, "learned-skills"),
      REPLY_CMD: "sms-cli send +15551234567", SCHEDULE_ARG: "--sms +15551234567",
    }),
  },
  chat: {
    template: "chat-prompt.md",
    tools: CHAT_TOOLS,
    skills: CHAT_SKILL_SRCS,
    defaults: (cwd) => ({
      PERSONA_NAME: "Baxter", CHAT_ID: "wc-7", HISTORY: "Erik: hello",
      HOUSEHOLD: "- Erik — erik@example.com", MORNING_HANDOFF: "", INTRO_NOTE: "",
      LOADED_SKILLS: "code, web, data, collections, schedule, proactive-follow-up",
      COLLECTIONS_LIST: "(none yet)", LEARNED_SKILLS_LIST: "(none yet)",
      MEMORY_PATH: join(cwd, "memory.md"), CREDENTIALS_PATH: join(cwd, "CREDENTIALS.md"),
      LEARNED_SKILLS_DIR: join(cwd, "learned-skills"),
    }),
  },
  heartbeat: {
    template: "heartbeat-prompt.md",
    tools: HEARTBEAT_TOOLS,
    skills: HEARTBEAT_SKILL_SRCS,
    defaults: (cwd) => ({
      PERSONA_NAME: "Baxter", TASK: "", DELIVER: "post the result to Discord channel chan1",
      OPERATOR_EMAIL: "operator@baxter.test",
      LOADED_SKILLS: "discord, code, web, data, collections",
      COLLECTIONS_LIST: "(none yet)", LEARNED_SKILLS_LIST: "(none yet)",
      HOUSEHOLD: "(nobody yet)", // hermetic like COLLECTIONS_LIST (operator-ratified 2026-08-17): heartbeat-prompt.md now carries {{HOUSEHOLD}} and renderScenarioPrompt throws on any unfilled slot, so the eval harness needs this default; it mirrors production's empty-roster line (household.ts) and reads NO real allowlist — evals must stay deterministic
      MEMORY_PATH: join(cwd, "memory.md"),
      MAIL_CLI_PATH: MAIL_CLI, // the model shouldn't use it; a heartbeat run has no schedule-cli
    }),
  },
};

// --- PURE pieces (unit-tested) ----------------------------------------------

// CONVERT the absolute `Bash(node <path>.ts *)` credential-CLI grants to their
// PATH-friendly `Bash(<basename> *)` form. The openrouter runner's
// parseAllowedTools is first-grant-wins, so converting the absolute grant makes
// the mail and Discord CLIs resolve via PATH -> mockbin. Dedup so a
// converted grant doesn't duplicate an existing friendly one.
export function doctorTools(tools: string): string {
  const converted = String(tools).replace(/Bash\(node (\S+) \*\)/g, (_, p) => `Bash(${basename(p, extname(p))} *)`);
  // Tokenize keeping `Bash(... *)` groups intact (they contain a space), then dedup.
  const toks = converted.match(/Bash\([^)]*\)|\S+/g) || [];
  const seen = new Set<string>();
  return toks.filter((t) => (seen.has(t) ? false : (seen.add(t), true))).join(" ");
}

// `surface` is loosely typed as `string` here (not the `Surface` union) so an
// unknown value throws at runtime rather than being rejected at compile time --
// exercised directly by harness.test.ts's `allowedToolsFor("nope")` case.
export function allowedToolsFor(surface: string): string {
  const s = SURFACES[surface as Surface];
  if (!s) throw new Error(`unknown eval surface "${surface}" (have: ${Object.keys(SURFACES).join(", ")})`);
  return doctorTools(s.tools);
}

// Surface defaults + cwd-derived paths, then the scenario's own slots (which win).
// `scenario` only needs `slots` here (harness.test.ts exercises this with bare
// `{ slots: {...} }` fixtures, not a full Scenario).
export function buildSlots(surface: string, scenario: { slots?: Record<string, string> }, cwd: string): Record<string, string> {
  const s = SURFACES[surface as Surface];
  if (!s) throw new Error(`unknown eval surface "${surface}"`);
  return { ...s.defaults(cwd), ...(scenario.slots || {}) };
}

// Render the REAL prompt template; throw if any {{SLOT}} was left unfilled (a
// literal {{X}} in the model's prompt is a bug we want loud, not silent).
export function renderScenarioPrompt(surface: string, scenario: { slots?: Record<string, string> }, cwd: string): string {
  const s = SURFACES[surface as Surface];
  if (!s) throw new Error(`unknown eval surface "${surface}"`);
  const template = readFileSync(join(APP_DIR, s.template), "utf8");
  const prompt = fillTemplate(template, buildSlots(surface, scenario, cwd));
  const missing = [...new Set([...prompt.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))];
  if (missing.length) throw new Error(`unfilled prompt slots for ${surface}: ${missing.join(", ")}`);
  return prompt;
}

// A scenario passes iff at least ceil(ratio*samples) of its samples passed.
export function passThreshold(passes: number, samples: number, ratio = 2 / 3): boolean {
  return samples > 0 && passes >= Math.ceil(ratio * samples);
}

// Only the fields formatTable actually reads (harness.test.ts exercises it with
// bare `{name,samples,passes,pass}` fixtures, not a full ScenarioRow).
export function formatTable(rows: Pick<ScenarioRow, "name" | "samples" | "passes" | "pass">[]): string {
  const lines = rows.map((r) => {
    const mark = r.pass ? "PASS" : "FAIL";
    return `  [${mark}] ${r.name}  (${r.passes}/${r.samples})`;
  });
  const passed = rows.filter((r) => r.pass).length;
  lines.push("", `  ${passed}/${rows.length} scenarios passed`);
  return lines.join("\n");
}

// --- impure driver ----------------------------------------------------------

export function stageScenarioSkills(surface: Surface, cwd: string, learnedSkillsDir: string): void {
  ensureSkills(SURFACES[surface].skills.filter(existsSync), join(cwd, ".claude", "skills"), learnedSkillsDir);
}

// Build a throwaway mockbin/ shadowing every MOCK_CLIS entry -> the committed handler.
function makeMockbin(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const cli of MOCK_CLIS) {
    const shim = `#!/usr/bin/env node\nimport { runMock } from ${JSON.stringify(MOCK_HANDLER)};\nrunMock(${JSON.stringify(cli)});\n`;
    const p = join(dir, cli);
    writeFileSync(p, shim);
    chmodSync(p, 0o755);
  }
}

interface RunSampleOpts {
  model?: string;
  harness?: string;
  onEvent?: (ev: NormalizedEvent) => void;
}

// Run one sample: fresh cwd, seed, mockbin+canned table, render, runAgent, capture.
// `onEvent` (optional) forwards each normalized runAgent event live (for progress).
async function runSample(surface: Surface, scenario: Scenario, { model, harness, onEvent }: RunSampleOpts) {
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

    // The build-generated playwright skill is absent in a source-only checkout;
    // stage every real source available here (including proactive-follow-up).
    stageScenarioSkills(surface, cwd, join(cwd, "learned-skills"));
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
    const events: NormalizedEvent[] = [];
    await runAgent({
      prompt, logId: "eval", surface, cwd, model, harness: getHarness(harness), // runAgent wants the adapter OBJECT
      allowedTools: allowedToolsFor(surface), runsDir: cwd,
      // receivedAt omitted: it's optional in RunAgentOptions and only read by runtime.ts's
      // !quiet "Finished" log, which never fires here (quiet: true) -- so it's unobservable
      // in eval runs. (Real callers pass an ISO string; this path never did meaningfully.)
      env, onEvent: (ev) => { events.push(ev); onEvent?.(ev); }, logEvents: false, quiet: true,
    });
    return captureFromEvents(events);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export interface RunScenarioOpts {
  model?: string;
  harness?: string;
  samples?: number;
  onSampleStart?: (info: { i: number; K: number }) => void;
  onEvent?: (ev: NormalizedEvent) => void;
  onSample?: (info: { i: number; K: number; pass: boolean }) => void;
}

// Run a scenario K times; a sample passes iff all its assertions pass. Optional live-
// progress hooks: `onSampleStart({i,K})` before each sample, `onEvent(ev)` for every
// tool call/turn as it happens, `onSample({i,K,pass})` when the sample resolves.
export async function runScenario(scenario: Scenario, { model, harness, samples = 3, onSampleStart, onEvent, onSample }: RunScenarioOpts = {}): Promise<ScenarioRow> {
  const K = scenario.samples ?? samples;
  const sampleResults: SampleResult[] = [];
  for (let i = 0; i < K; i++) {
    let capture, checks: AssertionResult[], pass: boolean;
    onSampleStart?.({ i, K });
    try {
      capture = await runSample(scenario.surface, scenario, { model, harness, onEvent });
      ({ pass, checks } = runAssertions(capture, scenario.expect || []));
    } catch (e) {
      pass = false; checks = [{ pass: false, why: `run threw: ${(e as Error).message}` }];
    }
    sampleResults.push({ pass, checks });
    onSample?.({ i, K, pass });
  }
  const passes = sampleResults.filter((r) => r.pass).length;
  return { name: scenario.name, samples: K, passes, pass: passThreshold(passes, K), sampleResults };
}

export interface RunSuiteOpts extends RunScenarioOpts {
  onScenarioStart?: (sc: Scenario, i: number, total: number) => void;
  onScenarioDone?: (row: ScenarioRow, i: number, total: number) => void;
}

// `onScenarioStart(scenario, idx, total)` / `onScenarioDone(row, idx, total)` (both
// optional) let a caller print live status; a real run is 3 slow model calls per
// scenario, so silence for the whole suite is a bad experience. All the print logic
// lives in the caller (run.ts) -- the harness only emits the events.
export async function runSuite(scenarios: Scenario[], opts: RunSuiteOpts = {}): Promise<{ rows: ScenarioRow[]; pass: boolean; table: string }> {
  const { onScenarioStart, onScenarioDone } = opts;
  const rows: ScenarioRow[] = [];
  for (let i = 0; i < scenarios.length; i++) {
    const sc = scenarios[i];
    onScenarioStart?.(sc, i, scenarios.length);
    const row = await runScenario(sc, opts); // opts carries onSample through
    onScenarioDone?.(row, i, scenarios.length);
    rows.push(row);
  }
  return { rows, pass: rows.every((r) => r.pass), table: formatTable(rows) };
}
