// The eval assertion library -- PURE predicates over the normalized event stream
// runAgent's onEvent emits. Each factory returns `(capture) => { pass, why }`, so a
// scenario reads `expect: [ calledTool("data-cli"), delivered(), ... ]`.
//
// We deliberately assert on STRUCTURAL behavior (which tools ran, whether a reply
// went out, bounds) rather than reply wording -- tool-use structure is far more
// stable across samples of a stochastic model than text (see the design doc).
import { isDeliveryCall } from "../scripts/harnesses/runner-common.mjs";

// Fold a normalized event stream into the shape the predicates read.
export function captureFromEvents(events) {
  const toolUses = [];
  const replies = [];
  let result = null;
  for (const ev of events || []) {
    if (ev.kind === "tool_use") {
      toolUses.push({ name: ev.name, input: ev.input });
      // A delivery call's stdin IS the message the user receives (the model's reply);
      // reuse the runner's own delivery classifier so eval + prod agree.
      if (isDeliveryCall(ev.name, ev.input)) replies.push(String(ev.input?.stdin ?? ""));
    } else if (ev.kind === "result") {
      result = { subtype: ev.subtype, text: ev.text ?? "" };
    }
  }
  return { events: events || [], toolUses, result, replies };
}

// A tool_use matches `target` if it's the native tool of that name (read_file,
// write_file, edit_file, load_skill) OR a run_cli of that cli; `sub`, when given,
// additionally requires that run_cli's first arg (the subcommand) to match.
function matchesTool(t, target, sub) {
  const isNative = t.name === target;
  const isCli = t.name === "run_cli" && t.input?.cli === target;
  if (!isNative && !isCli) return false;
  if (sub == null) return true;
  return isCli && Array.isArray(t.input?.args) && t.input.args[0] === sub;
}
const label = (target, sub) => (sub == null ? target : `${target} ${sub}`);

const CMP = {
  "<=": (a, b) => a <= b, ">=": (a, b) => a >= b,
  "<": (a, b) => a < b, ">": (a, b) => a > b, "==": (a, b) => a === b,
};

export function calledTool(target, sub) {
  return (cap) => {
    const hit = cap.toolUses.some((t) => matchesTool(t, target, sub));
    return { pass: hit, why: `${hit ? "called" : "did NOT call"} ${label(target, sub)}` };
  };
}
export function notCalledTool(target, sub) {
  return (cap) => {
    const hit = cap.toolUses.some((t) => matchesTool(t, target, sub));
    return { pass: !hit, why: hit ? `unexpectedly called ${label(target, sub)}` : `never called ${label(target, sub)}` };
  };
}
export function toolCallCount(cmp, n) {
  return (cap) => {
    const c = cap.toolUses.length;
    const fn = CMP[cmp];
    if (!fn) throw new Error(`toolCallCount: unknown comparator ${JSON.stringify(cmp)}`);
    return { pass: fn(c, n), why: `tool calls: ${c} (want ${cmp} ${n})` };
  };
}
export function succeeded() {
  return (cap) => {
    const s = cap.result?.subtype === "success";
    return { pass: s, why: `result subtype: ${cap.result?.subtype ?? "(none)"}` };
  };
}
export function delivered() {
  return (cap) => ({ pass: cap.replies.length > 0, why: cap.replies.length ? `delivered ${cap.replies.length} message(s)` : "never delivered a reply/send" });
}
export function replyMatches(re) {
  return (cap) => {
    const hit = cap.replies.some((r) => re.test(r));
    return { pass: hit, why: hit ? `a reply matched ${re}` : `no reply matched ${re}` };
  };
}
export function replyOmits(re) {
  return (cap) => {
    const hit = cap.replies.some((r) => re.test(r));
    return { pass: !hit, why: hit ? `a reply matched ${re} (should be absent)` : `no reply matched ${re} (good)` };
  };
}
export function custom(fn, desc = "custom") {
  return (cap) => {
    const r = fn(cap);
    return typeof r === "boolean" ? { pass: r, why: desc } : r;
  };
}

// Run a list of predicates against one capture -> { pass, checks:[{pass,why}] }.
export function runAssertions(capture, predicates) {
  const checks = (predicates || []).map((p) => p(capture));
  return { pass: checks.every((c) => c.pass), checks };
}
