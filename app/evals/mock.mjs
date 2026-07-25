// The generic eval CLI mock. Every mockable CLI (discord-cli, data-cli, web-cli,
// code-cli, …) is intercepted by a tiny generated shim in the eval's temp `mockbin/`
// that calls runMock(<its own name>) here. The mock's ONLY job is to return a
// plausible result so the model keeps going -- the assertions read the model's
// ACTIONS from runAgent's onEvent trace (which already captured this call's cli/
// args/stdin BEFORE the mock ran), so the mock never needs to record anything.
//
// Per-scenario canned responses come from EVAL_MOCK_TABLE (a JSON file): a map of
//   { "<cli>": <string> }  or  { "<cli>": { "<subcommand>": <string>, "*": <string> } }
// Absent → a per-cli default (a fake Discord message for discord-cli; "" otherwise).
import { readFileSync } from "node:fs";

function drainStdin() {
  // Consume the piped body (a reply text, a program, …) so the writer doesn't EPIPE.
  try { readFileSync(0, "utf8"); } catch { /* no stdin / already closed */ }
}

function cannedTable() {
  const p = process.env.EVAL_MOCK_TABLE;
  if (!p) return {};
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
}

// A believable default per CLI when the scenario didn't pin one.
function defaultResponse(cli, sub) {
  if (cli === "discord-cli") {
    if (sub === "reply" || sub === "send" || sub === "send-thread") {
      return JSON.stringify({ id: "mockmsg1", type: 0, content: "(mock)", message_ids: ["mockmsg1"], chunked: false });
    }
    if (sub === "whoami") return JSON.stringify({ id: "999000", username: "Baxter" });
    return ""; // react / typing / etc.
  }
  return ""; // web-cli/data-cli/etc.: empty is a valid (if unhelpful) result
}

export function runMock(cli) {
  drainStdin();
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const table = cannedTable();
  const entry = table[cli];
  let out;
  if (typeof entry === "string") out = entry;
  else if (entry && typeof entry === "object") out = entry[sub] ?? entry["*"];
  if (out == null) out = defaultResponse(cli, sub);
  if (out !== "") process.stdout.write(String(out) + (String(out).endsWith("\n") ? "" : "\n"));
  process.exit(0);
}
