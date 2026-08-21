// run-observer: the harness-neutral, passive per-run observer fed to runAgent
// as onEvent. It records only successful outbound Mail/SMS deliveries as raw
// {target, text} pairs for one dispatched run. One instance must not be shared
// across concurrent runs because tool uses/results are paired by stream FIFO.
//
// Both supported invocation families are classified behind explicit payload
// guards, so malformed input records nothing and never throws:
//  - structured run_cli uses with {cli, args, stdin?}; and
//  - Claude Bash uses with {command}.
//
// This classifies already-executed, allowlisted tool events; it is not an
// authorization boundary. URL and Home-route matching remain entirely in
// feature-discovery.ts.
import { basename, isAbsolute } from "node:path";
import { tokenizeCommand, type ShellSegment, type ShellWord } from "./shell-tokens.ts";
import type { DiscoveryObservation } from "./feature-discovery.ts";
import type { NormalizedEvent } from "./runtime.ts";

type Family = "structured" | "claude";
type Delivery = { target: string; text: string };
type Pending = { family: Family; delivery: Delivery };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Structured results additionally expose ToolResult.ok; Claude Bash content is
// arbitrary, so only isError determines success for that family.
function resultSucceeded(ev: NormalizedEvent, family: Family): boolean {
  if (ev.isError === true) return false;
  if (family === "claude") return true;
  return !(isPlainObject(ev.content) && "ok" in ev.content && ev.content.ok === false);
}

// Only delivery to the current surface can introduce a feature: mail reply and
// SMS 1:1/group sends. The trigger-target equality check happens later in
// concludeDiscovery; here we preserve the exact non-empty target string.
function qualifyingDeliveryTarget(cli: string, verb: unknown, target: unknown): string | null {
  const qualifies =
    (cli === "mail-cli" && verb === "reply") ||
    (cli === "sms-cli" && (verb === "send" || verb === "send-group"));
  if (!qualifies) return null;
  return typeof target === "string" && target !== "" ? target : null;
}

function classifyRunCli(input: unknown): Pending | null {
  if (!isPlainObject(input)) return null;
  const { cli, args, stdin } = input as { cli?: unknown; args?: unknown; stdin?: unknown };
  if (typeof cli !== "string") return null;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return null;
  if (stdin !== undefined && typeof stdin !== "string") return null;
  const target = qualifyingDeliveryTarget(cli, args[0], args[1]);
  if (target === null) return null;
  return { family: "structured", delivery: { target, text: stdin ?? "" } };
}

function classifyBash(input: unknown): Pending | null {
  if (!isPlainObject(input)) return null;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string") return null;
  const lexed = tokenizeCommand(command);
  if (!lexed.ok) return null;
  const delivery = classifySegments(lexed.segments);
  return delivery === null ? null : { family: "claude", delivery };
}

// Resolve PATH-shim calls directly, or the grants' node /absolute/tool.ts form.
// Exact basename matching rejects lookalikes and non-TypeScript script paths.
function resolveExecutable(argv: ShellWord[]): { name: string; argStart: number } | null {
  const first = argv[0]?.text;
  if (first === undefined) return null;
  if (first !== "node") return { name: first, argStart: 1 };
  const script = argv[1]?.text;
  if (script === undefined || !isAbsolute(script)) return null;
  const base = basename(script);
  if (!base.endsWith(".ts")) return null;
  return { name: base.slice(0, -".ts".length), argStart: 2 };
}

// Accepted Claude delivery shapes:
//  - one mail/sms command with a heredoc body; or
//  - a printf/echo literal producer piped into one mail/sms command.
function classifySegments(segments: ShellSegment[]): Delivery | null {
  if (segments.length === 1) {
    const seg = segments[0];
    const exe = resolveExecutable(seg.argv);
    if (exe === null || !seg.heredoc) return null;
    const target = qualifyingDeliveryTarget(
      exe.name,
      seg.argv[exe.argStart]?.text,
      seg.argv[exe.argStart + 1]?.text,
    );
    return target === null ? null : { target, text: seg.heredoc.body };
  }
  if (segments.length === 2) {
    const [producer, consumer] = segments;
    // A consumer heredoc replaces piped stdin in a real shell, so that shape is
    // rejected rather than attributing the producer's text incorrectly.
    if (producer.heredoc || consumer.heredoc) return null;
    const producerExe = producer.argv[0]?.text;
    if (producerExe !== "printf" && producerExe !== "echo") return null;
    const consumerExe = resolveExecutable(consumer.argv);
    if (consumerExe === null) return null;
    const target = qualifyingDeliveryTarget(
      consumerExe.name,
      consumer.argv[consumerExe.argStart]?.text,
      consumer.argv[consumerExe.argStart + 1]?.text,
    );
    if (target === null) return null;
    return { target, text: producer.argv.slice(1).map((w) => w.text).join(" ") };
  }
  return null;
}

export class RunObserver {
  // Every tool_use occupies a slot because tool_result events carry no tool
  // name. A null slot keeps unrelated tools from shifting later pairings.
  private readonly queue: Array<Pending | null> = [];
  private readonly deliveries: Delivery[] = [];

  observe(ev: NormalizedEvent): void {
    if (ev.kind === "tool_use") {
      const pending =
        ev.name === "run_cli" ? classifyRunCli(ev.input) : ev.name === "Bash" ? classifyBash(ev.input) : null;
      this.queue.push(pending);
      return;
    }
    if (ev.kind === "tool_result") {
      const pending = this.queue.shift();
      if (pending === undefined || pending === null || !resultSucceeded(ev, pending.family)) return;
      this.deliveries.push(pending.delivery);
    }
  }

  summary(): DiscoveryObservation {
    return { deliveries: this.deliveries.map((d) => ({ ...d })) };
  }
}
