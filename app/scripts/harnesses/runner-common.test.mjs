// Unit tests for the shared runner pieces: the tool-spec set derived from a run's
// grants, and the JSON-Schema rendering the local (chat/completions) runner uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolSpecs, toJsonSchema, systemPreamble } from "./runner-common.mjs";
import { parseAllowedTools } from "./openrouter-tools.mjs";

test("toolSpecs yields run_cli plus the granted native tools", () => {
  const { cliMap, native } = parseAllowedTools("Bash(discord-cli *) Bash(web-cli *) Read Write Skill");
  const specs = toolSpecs(cliMap, native);
  assert.deepEqual(specs.map((s) => s.name).sort(), ["load_skill", "read_file", "run_cli", "write_file"]);
  const runCli = specs.find((s) => s.name === "run_cli");
  assert.match(runCli.description, /discord-cli, web-cli/); // available CLIs listed
});

test("toolSpecs omits run_cli when no CLI is granted, and only builds granted native tools", () => {
  const { cliMap, native } = parseAllowedTools("Read Edit");
  assert.deepEqual(toolSpecs(cliMap, native).map((s) => s.name).sort(), ["edit_file", "read_file"]);
});

test("toJsonSchema renders params to OpenAI-style JSON Schema", () => {
  const spec = {
    params: [
      { name: "cli", type: "string", required: true, description: "the cli" },
      { name: "args", type: "string[]", required: false },
      { name: "stdin", type: "string", required: false },
    ],
  };
  const js = toJsonSchema(spec);
  assert.equal(js.type, "object");
  assert.deepEqual(js.properties.cli, { type: "string", description: "the cli" });
  assert.deepEqual(js.properties.args, { type: "array", items: { type: "string" } });
  assert.deepEqual(js.properties.stdin, { type: "string" });
  assert.deepEqual(js.required, ["cli"]); // only required params
});

test("systemPreamble lists the run's CLIs and bridges WebSearch/WebFetch to web-cli", () => {
  const { cliMap } = parseAllowedTools("Bash(discord-cli *) Bash(web-cli *)");
  const p = systemPreamble(cliMap);
  assert.match(p, /Available CLIs: discord-cli, web-cli/);
  assert.match(p, /web-cli.*search/s);
  // "act, don't narrate": sending a reply is a tool call, not final-message text
  // (guards against the qwen3.6-flash narrate-instead-of-act give-up).
  assert.match(p, /never just text in your final message/);
  assert.match(p, /leaves the task UNDONE/);
});
