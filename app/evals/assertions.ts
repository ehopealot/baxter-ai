// The eval assertion library -- PURE predicates over the normalized event stream
// runAgent's onEvent emits. Each factory returns `(capture) => { pass, why }`, so a
// scenario reads `expect: [ calledTool("data-cli"), delivered(), ... ]`.
//
// We deliberately assert on STRUCTURAL behavior (which tools ran, whether a reply
// went out, bounds) rather than reply wording -- tool-use structure is far more
// stable across samples of a stochastic model than text (see the design doc).
import type { NormalizedEvent } from "../scripts/runtime.ts";
import { isDeliveryCall } from "../scripts/harnesses/runner-common.ts";
import { isDeepStrictEqual } from "node:util";

// One recorded tool_use, as captureFromEvents folds it -- name/input straight off
// the normalized event (input stays unknown at this boundary, like runtime.ts's
// own NormalizedEvent -- harness- and tool-specific).
export interface ToolUseCapture {
  name?: string;
  input?: unknown;
}

// The shape every assertion predicate reads. Built once per sample by
// captureFromEvents from the run's normalized event stream.
export interface Capture {
  events: NormalizedEvent[];
  toolUses: ToolUseCapture[];
  result: { subtype?: string; text: string } | null;
  replies: string[];
}

export interface AssertionResult {
  pass: boolean;
  why: string;
}

// A predicate factory (calledTool/delivered/...) returns one of these -- the
// scenario's `expect: Assertion[]` list.
export type Assertion = (capture: Capture) => AssertionResult;

// Fold a normalized event stream into the shape the predicates read.
export function captureFromEvents(events: NormalizedEvent[] | null | undefined): Capture {
  const toolUses: ToolUseCapture[] = [];
  const replies: string[] = [];
  let result: Capture["result"] = null;
  for (const ev of events || []) {
    if (ev.kind === "tool_use") {
      toolUses.push({ name: ev.name, input: ev.input });
      // A delivery call's stdin IS the message the user receives (the model's reply);
      // reuse the runner's own delivery classifier so eval + prod agree.
      if (isDeliveryCall(ev.name ?? "", ev.input as Record<string, unknown> | null | undefined)) {
        const input = ev.input as Record<string, unknown> | undefined;
        replies.push(String(input?.stdin ?? ""));
      }
    } else if (ev.kind === "result") {
      result = { subtype: ev.subtype, text: ev.text ?? "" };
    }
  }
  return { events: events || [], toolUses, result, replies };
}

// A tool_use matches `target` if it's the native tool of that name (read_file,
// write_file, edit_file, load_skill) OR a run_cli of that cli; `sub`, when given,
// additionally requires that run_cli's first arg (the subcommand) to match.
function matchesTool(t: ToolUseCapture, target: string, sub?: string | null): boolean {
  const isNative = t.name === target;
  const input = t.input as Record<string, unknown> | undefined;
  const isCli = t.name === "run_cli" && input?.cli === target;
  if (!isNative && !isCli) return false;
  if (sub == null) return true;
  return isCli && Array.isArray(input?.args) && (input!.args as unknown[])[0] === sub;
}
const label = (target: string, sub?: string | null): string => (sub == null ? target : `${target} ${sub}`);

const CMP: Record<string, (a: number, b: number) => boolean> = {
  "<=": (a, b) => a <= b, ">=": (a, b) => a >= b,
  "<": (a, b) => a < b, ">": (a, b) => a > b, "==": (a, b) => a === b,
};

export function calledTool(target: string, sub?: string | null): Assertion {
  return (cap) => {
    const hit = cap.toolUses.some((t) => matchesTool(t, target, sub));
    return { pass: hit, why: `${hit ? "called" : "did NOT call"} ${label(target, sub)}` };
  };
}
export function notCalledTool(target: string, sub?: string | null): Assertion {
  return (cap) => {
    const hit = cap.toolUses.some((t) => matchesTool(t, target, sub));
    return { pass: !hit, why: hit ? `unexpectedly called ${label(target, sub)}` : `never called ${label(target, sub)}` };
  };
}
export function calledCliWith(cli: string, args: unknown[]): Assertion {
  return (cap) => {
    const hit = cap.toolUses.some((tool) => {
      const input = tool.input as Record<string, unknown> | undefined;
      return tool.name === "run_cli" && input?.cli === cli && isDeepStrictEqual(input.args, args);
    });
    return { pass: hit, why: `${hit ? "called" : "did NOT call"} ${cli} with exact argv ${JSON.stringify(args)}` };
  };
}

export function cliCallCount(cli: string, sub: string | null, cmp: string, n: number): Assertion {
  return (cap) => {
    const count = cap.toolUses.filter((tool) => matchesTool(tool, cli, sub)).length;
    const fn = CMP[cmp];
    if (!fn) throw new Error(`cliCallCount: unknown comparator ${JSON.stringify(cmp)}`);
    return { pass: fn(count, n), why: `${label(cli, sub)} calls: ${count} (want ${cmp} ${n})` };
  };
}

export function toolCallCount(cmp: string, n: number): Assertion {
  return (cap) => {
    const c = cap.toolUses.length;
    const fn = CMP[cmp];
    if (!fn) throw new Error(`toolCallCount: unknown comparator ${JSON.stringify(cmp)}`);
    return { pass: fn(c, n), why: `tool calls: ${c} (want ${cmp} ${n})` };
  };
}
export function succeeded(): Assertion {
  return (cap) => {
    const s = cap.result?.subtype === "success";
    return { pass: s, why: `result subtype: ${cap.result?.subtype ?? "(none)"}` };
  };
}
export function delivered(): Assertion {
  return (cap) => ({ pass: cap.replies.length > 0, why: cap.replies.length ? `delivered ${cap.replies.length} message(s)` : "never delivered a reply/send" });
}
export function replyMatches(re: RegExp): Assertion {
  return (cap) => {
    const hit = cap.replies.some((r) => re.test(r));
    return { pass: hit, why: hit ? `a reply matched ${re}` : `no reply matched ${re}` };
  };
}
export function replyOmits(re: RegExp): Assertion {
  return (cap) => {
    const hit = cap.replies.some((r) => re.test(r));
    return { pass: !hit, why: hit ? `a reply matched ${re} (should be absent)` : `no reply matched ${re} (good)` };
  };
}
export function custom(fn: (cap: Capture) => boolean | AssertionResult, desc = "custom"): Assertion {
  return (cap) => {
    const r = fn(cap);
    return typeof r === "boolean" ? { pass: r, why: desc } : r;
  };
}

// Run a list of predicates against one capture -> { pass, checks:[{pass,why}] }.
export function runAssertions(capture: Capture, predicates: Assertion[] | null | undefined): { pass: boolean; checks: AssertionResult[] } {
  const checks = (predicates || []).map((p) => p(capture));
  return { pass: checks.every((c) => c.pass), checks };
}
