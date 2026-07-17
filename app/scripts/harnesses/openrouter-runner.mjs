#!/usr/bin/env node
// OpenRouter harness runner -- an alternative to `claude -p` for driving Baxter.
// Spawned by runtime.mjs's runAgent (via harnesses/openrouter.mjs) exactly like
// claude: it reads the rendered prompt on STDIN, runs @openrouter/agent's
// callModel loop with our structured tools, and emits normalized JSONL events on
// stdout (decoded by the adapter's parseEvents) plus a final `result` line.
//
// The security-critical tool logic (CLI allowlist, cwd confinement) lives in
// openrouter-tools.mjs; the shared preamble + tool set live in runner-common.mjs;
// this file only renders those specs into the SDK's zod tool() form and drives
// callModel. cwd is set by the spawning daemon to MEMORY_DIR (bounds file
// access); the daemon also strips the Discord/Gmail tokens from this env.
import { OpenRouter, tool, stepCountIs } from "@openrouter/agent";
import { z } from "zod";
import { parseAllowedTools } from "./openrouter-tools.mjs";
import { emit, argOf, readStdin, systemPreamble, toolSpecs, runTool, EMPTY_TURN_NUDGE } from "./runner-common.mjs";
import { envInt } from "../schedule-store.mjs";

// envInt fails loud on a non-integer value rather than propagating NaN: a NaN
// step cap makes stepCountIs never fire (unbounded loop on a paid API), a NaN
// timeout is falsy (no CLI timeout), and a NaN byte cap blanks every output.
const CLI_OUT_MAX_BYTES = envInt("OPENROUTER_CLI_OUTPUT_MAX_BYTES", 256 * 1024);
const CLI_TIMEOUT_MS = envInt("OPENROUTER_CLI_TIMEOUT_MS", 120000);
const MAX_STEPS = envInt("OPENROUTER_MAX_STEPS", 40);

// Render a shared tool spec's params into the Agent SDK's zod input schema.
function zodSchema(spec) {
  const shape = {};
  for (const p of spec.params) {
    let s = p.type === "string[]" ? z.array(z.string()) : z.string();
    if (p.description) s = s.describe(p.description);
    if (!p.required) s = s.optional();
    shape[p.name] = s;
  }
  return z.object(shape);
}

function buildTools(specs, ctx) {
  return specs.map((spec) =>
    tool({
      name: spec.name,
      description: spec.description,
      inputSchema: zodSchema(spec),
      execute: (params) => runTool(spec, params, ctx), // emits tool_use/tool_result, runs the executor
    }),
  );
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
  // A missing key/model is a HARD error, not "clean but capped": exit nonzero so
  // runAgent's `failed` fires (heartbeat retries; poll/discord don't drop it as a
  // successful no-reply). Only 402/429 (out-of-tokens) is the exit-0 case.
  const failHard = (text) => {
    emit({ t: "result", subtype: "error", text, out_of_tokens: false, resets_at: null });
    process.exitCode = 1;
  };
  if (!apiKey) return failHard("OPENROUTER_API_KEY is not set");
  if (!model) return failHard("OPENROUTER_MODEL is not set");

  const { cliMap, native } = parseAllowedTools(argOf("--allowed") ?? "");
  const prompt = await readStdin();
  const ctx = { cwd: process.cwd(), cliMap, env: process.env, timeoutMs: CLI_TIMEOUT_MS, maxBytes: CLI_OUT_MAX_BYTES };
  const tools = buildTools(toolSpecs(cliMap, native), ctx);

  const client = new OpenRouter({ apiKey });
  const instructions = systemPreamble(cliMap);
  try {
    // callModel takes `instructions` (system text) + `input` (the user prompt, a
    // string), NOT a `messages` array -- an unknown key is dropped silently.
    const result = client.callModel({
      model,
      instructions,
      input: prompt,
      tools,
      stopWhen: [stepCountIs(MAX_STEPS)],
      allowFinalResponse: true,
    });
    let text = await result.getText();
    // Empty final turn (no text, no tool call) -> the model gave up mid-task
    // (e.g. after a tool error). Baxter's reply is itself a tool call, so an
    // empty turn means it stops WITHOUT replying. Nudge ONCE: resume the
    // conversation (getState -> a load-only StateAccessor) with a follow-up user
    // message. Best-effort -- any resume failure falls back to the empty result
    // (never worse than before); the reused `tools` mean a tool call in the
    // nudged turn (e.g. finally sending the reply) still executes and emits.
    if (!text || !text.trim()) {
      try {
        console.error("[openrouter-runner] model ended with an empty turn; nudging once");
        const state = await result.getState();
        const nudged = client.callModel({
          model,
          instructions,
          input: EMPTY_TURN_NUDGE,
          tools,
          stopWhen: [stepCountIs(MAX_STEPS)],
          allowFinalResponse: true,
          state: { load: async () => state, save: async () => {} },
        });
        const nudgedText = await nudged.getText();
        if (nudgedText && nudgedText.trim()) text = nudgedText;
      } catch (nudgeErr) {
        const m = String(nudgeErr?.message ?? nudgeErr);
        // A rate-limit/credit error DURING the nudge is still out-of-tokens --
        // let the outer catch classify it. Anything else: keep the empty result.
        if (/\b402\b|\b429\b|insufficient|rate.?limit|quota|too many requests/i.test(m)) throw nudgeErr;
        console.error(`[openrouter-runner] empty-turn nudge failed: ${m}`);
      }
    }
    if (text && text.trim()) emit({ t: "text", text });
    emit({ t: "result", subtype: "success", text: text ?? "", out_of_tokens: false, resets_at: null });
  } catch (err) {
    const msg = String(err?.message ?? err);
    // OpenRouter: 402 = out of credits, 429 = rate limited -- the analog of
    // Claude's out-of-tokens, so the daemons' "couldn't get to this" path fires.
    // Everything else is a HARD error: exit nonzero so runAgent's `failed` fires.
    const outOfTokens = /\b402\b|\b429\b|insufficient|rate.?limit|quota|too many requests/i.test(msg);
    emit({ t: "result", subtype: "error", text: msg, out_of_tokens: outOfTokens, resets_at: null });
    if (!outOfTokens) process.exitCode = 1;
  }
}

main().catch((err) => {
  emit({ t: "result", subtype: "error", text: `runner crashed: ${err?.message ?? err}`, out_of_tokens: false, resets_at: null });
  process.exit(1);
});
