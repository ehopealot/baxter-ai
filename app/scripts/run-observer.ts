// run-observer: the harness-neutral, PASSIVE per-run observer fed to runAgent
// as onEvent (spec: docs/superpowers/specs/2026-08-19-cross-surface-home-link-
// discovery-design.md §4/§5; plan task T6). It records, for ONE dispatched
// run (one instance per run -- the FIFO pairing below is per-stream, so an
// instance must never be shared across concurrent runs):
//
//  - successful feature INTERACTIONS (a qualifying feature CLI call), and
//  - successful outbound DELIVERIES to the conversation's own channel, as
//    raw {target, text} pairs (target = thread id / phone number / group id;
//    text = the stdin / heredoc / producer-literal reply body).
//
// Both invocation families are classified, each behind an explicit payload
// SHAPE guard (spec §4: malformed payloads create no interactions and no
// deliveries, and never throw -- the Bash guard runs BEFORE tokenizeCommand,
// because NormalizedEvent.input is typed unknown):
//  - the structured family (openrouter/openai/custom/local harnesses):
//    tool_use name 'run_cli' with input {cli, args, stdin?}, where cli is the
//    friendly grant name; tool_result content is the ToolResult object
//    ({ok?: boolean, ...}), so failure is visible as isError OR content.ok === false.
//  - the opt-in Claude family: tool_use name 'Bash' with input {command};
//    tool_result carries Claude content with isError and no ok field.
//
// This is classification of ALREADY-EXECUTED, allowlisted tool events, never
// an authorization boundary (the grants and the runner remain that), and it
// never inspects reply text for URLs: all route/link matching happens later,
// in feature-discovery's multi-valued deliveredLinkFeatures/concludeDiscovery.
import { basename, isAbsolute } from "node:path";
import { tokenizeCommand, type ShellSegment, type ShellWord } from "./shell-tokens.ts";
import { FEATURE_CATALOG, type DiscoveryObservation } from "./feature-discovery.ts";
import { FEATURE_KEYS, type FeatureKey } from "./intro-state.ts";
import type { NormalizedEvent } from "./runtime.ts";

// What one classified (and still unproven) tool_use may contribute once its
// FIFO-paired tool_result reports success. null = "records nothing" (unrelated
// tool, rejected shape, or malformed payload). The family tag records WHICH
// invocation family classified the use, because the two families have
// different result-success semantics (see resultSucceeded).
type Pending =
  | { kind: "interaction"; family: "structured" | "claude"; feature: FeatureKey }
  | { kind: "delivery"; family: "structured" | "claude"; delivery: { target: string; text: string } };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// A tool_result is a success when it is not an error on the wire (isError).
// The ok:false failure signal is the STRUCTURED family's ToolResult content
// shape and is checked for that family ONLY (spec §4: "isError !== true and,
// for structured results, content.ok !== false"): Claude/Bash result content
// is arbitrary raw content passed through as unknown (harnesses/claude.ts),
// so a successful Bash result whose content happens to be {ok:false} still
// succeeded -- isError alone decides it.
function resultSucceeded(ev: NormalizedEvent, family: "structured" | "claude"): boolean {
  if (ev.isError === true) return false;
  if (family === "claude") return true;
  if (isPlainObject(ev.content)) {
    const toolResult = ev.content as { ok?: unknown };
    if ("ok" in toolResult && toolResult.ok === false) return false;
  }
  return true;
}

// Catalog lookup by EXACT cli-name equality ('calendar-cli-evil' and any other
// prefix never match). schedule-cli is narrowed to its qualifying verbs
// (add/list/cancel); 'groups' -- a delivery-target lookup -- never qualifies.
function catalogInteraction(cli: string, verb: string | undefined): FeatureKey | null {
  for (const key of FEATURE_KEYS) {
    const entry = FEATURE_CATALOG[key];
    if (entry.cli !== cli) continue;
    if (entry.verbs && !(verb !== undefined && entry.verbs.includes(verb))) return null;
    return key;
  }
  return null;
}

// The qualifying delivery shapes (spec §4): mail-cli reply <threadId> and
// sms-cli send <number> / send-group <groupId>. mail 'send', sms
// 'send-contact'/'read' are real commands but never THIS conversation's
// qualifying delivery. Returns the target when the shape qualifies (verb plus
// a non-empty target argument), else null -- a missing/empty target (e.g.
// {cli:'sms-cli', args:['send']}) must never become a delivery.
function qualifyingDeliveryTarget(cli: string, verb: unknown, target: unknown): string | null {
  const isDeliveryVerb =
    (cli === "mail-cli" && verb === "reply") ||
    (cli === "sms-cli" && (verb === "send" || verb === "send-group"));
  if (!isDeliveryVerb) return null;
  return typeof target === "string" && target !== "" ? target : null;
}

// The structured family. Every shape rule is checked BEFORE anything can be
// recorded: input a non-null non-array object, cli a string, args an array of
// strings, stdin absent or a string.
function classifyRunCli(input: unknown): Pending | null {
  if (!isPlainObject(input)) return null;
  const { cli, args, stdin } = input as { cli?: unknown; args?: unknown; stdin?: unknown };
  if (typeof cli !== "string") return null;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return null;
  if (stdin !== undefined && typeof stdin !== "string") return null;
  const interaction = catalogInteraction(cli, args[0]);
  if (interaction !== null) return { kind: "interaction", family: "structured", feature: interaction };
  const target = qualifyingDeliveryTarget(cli, args[0], args[1]);
  if (target !== null) return { kind: "delivery", family: "structured", delivery: { target, text: stdin ?? "" } };
  return null;
}

// The Claude Bash family: the same explicit payload-shape guard FIRST (a
// malformed payload never reaches the lexer), then tokenizeCommand -- every
// lex-time rejection (separators, background, redirects, substitutions in
// executing positions, comments, unterminated quoting) lands here as {ok:false}
// and records nothing.
function classifyBash(input: unknown): Pending | null {
  if (!isPlainObject(input)) return null;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string") return null;
  const lexed = tokenizeCommand(command);
  if (!lexed.ok) return null;
  return classifySegments(lexed.segments);
}

// A segment's executable plus where that CLI's own arguments begin. The
// node form ('node /abs/path/tool.ts ...', the grants.ts MAIL_CLI/SMS_CLI
// grant shape) resolves ONLY when argv[1] is an ABSOLUTE path whose final
// segment ends exactly '.ts' -- resolved name = that final segment minus the
// extension, and the CLI's arguments then start AFTER the script path -- so an
// exact-name match still decides and 'node /app/scripts/calendar-cli-evil.ts'
// or 'node /tmp/mail-cli.js' resolves to nothing.
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

// Classification over the (at most two) lexed segments. The tokenizer has
// already guaranteed no separators/redirects/substitutions survived, so argv
// tails are NOT otherwise inspected. Accepted shapes only; anything else is
// null (fail open):
//  (a) one segment, executable a catalog CLI (with the schedule-cli verb
//      rule) -- an optional trailing heredoc (collections-cli save) is fine;
//  (b) one segment, executable mail-cli 'reply' <target> or sms-cli
//      'send'/'send-group' <target>, WITH a heredoc body as the reply text
//      (no heredoc is not a recognized delivery);
//  (c) exactly two segments: a printf/echo producer piped into (b)'s shape,
//      text = the producer's argument texts joined with ' '.
function classifySegments(segments: ShellSegment[]): Pending | null {
  if (segments.length === 1) {
    const seg = segments[0];
    const exe = resolveExecutable(seg.argv);
    if (exe === null) return null;
    const verb = seg.argv[exe.argStart]?.text;
    const interaction = catalogInteraction(exe.name, verb);
    if (interaction !== null) return { kind: "interaction", family: "claude", feature: interaction };
    if (seg.heredoc) {
      const target = qualifyingDeliveryTarget(exe.name, verb, seg.argv[exe.argStart + 1]?.text);
      if (target !== null) return { kind: "delivery", family: "claude", delivery: { target, text: seg.heredoc.body } };
    }
    return null;
  }
  if (segments.length === 2) {
    const [producer, consumer] = segments;
    // A heredoc on the piped command would REPLACE the piped stdin in a real
    // shell, so the producer text could never be trusted -- fail open.
    if (producer.heredoc || consumer.heredoc) return null;
    const producerExe = producer.argv[0]?.text;
    if (producerExe !== "printf" && producerExe !== "echo") return null; // non-producer left side
    const consumerExe = resolveExecutable(consumer.argv);
    if (consumerExe === null) return null;
    const target = qualifyingDeliveryTarget(consumerExe.name, consumer.argv[consumerExe.argStart]?.text, consumer.argv[consumerExe.argStart + 1]?.text);
    if (target === null) return null; // feature CLIs and non-delivery verbs never count in a pipe
    const text = producer.argv.slice(1).map((w) => w.text).join(" ");
    return { kind: "delivery", family: "claude", delivery: { target, text } };
  }
  return null;
}

export class RunObserver {
  // The pending-tool_use FIFO. tool_result events carry NO tool name on any
  // harness wire, so each result is paired with the use that preceded it in
  // the stream (the same contract as runtime.ts's metering queue) and commits
  // ONLY that pairing; a result with no pending use records nothing.
  private readonly queue: Array<Pending | null> = [];
  private readonly interactions = new Set<FeatureKey>(); // duplicates collapse
  private readonly deliveries: Array<{ target: string; text: string }> = [];

  observe(ev: NormalizedEvent): void {
    if (ev.kind === "tool_use") {
      // EVERY tool_use occupies a FIFO slot (unrelated tools classify to
      // null), so a later result cannot misattribute to an earlier use.
      const pending =
        ev.name === "run_cli" ? classifyRunCli(ev.input) : ev.name === "Bash" ? classifyBash(ev.input) : null;
      this.queue.push(pending);
      return;
    }
    if (ev.kind === "tool_result") {
      const pending = this.queue.shift();
      if (pending === undefined || pending === null || !resultSucceeded(ev, pending.family)) return;
      if (pending.kind === "interaction") this.interactions.add(pending.feature);
      else this.deliveries.push(pending.delivery);
    }
  }

  summary(): DiscoveryObservation {
    // Interactions deduped in canonical FEATURE_KEYS order (order-stable);
    // deliveries in stream order, as raw {target, text} copies.
    return {
      interactions: FEATURE_KEYS.filter((k) => this.interactions.has(k)),
      deliveries: this.deliveries.map((d) => ({ ...d })),
    };
  }
}
