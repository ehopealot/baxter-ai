// Per-tenant usage-signal ledger: one best-effort JSONL append per tool call /
// SMS / mail message, read by the HOST-side usage exporter (python) for the
// tool/sms/mail panels and alerts -- unlike usage-store.ts there is no in-core
// read path. Physically per-tenant because STATE_DIR is the per-tenant config
// volume. Lock-free append (usage-store.ts / access-log.ts pattern): several
// surface CONTAINERS of one tenant share the config volume and append this file
// concurrently. Each line is written with one appendFileSync() on an O_APPEND
// fd; on a local fs (the docker named volume) the kernel serializes the append
// per-inode so lines don't interleave (Node loops writeSync internally, but a
// ~150-byte write to a local regular file lands in one call). The free-form
// fields are length-clamped as belt-and-suspenders (NOT NFS-safe).
// See docs/superpowers/specs/2026-08-14-usage-metrics-design.md.
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { USAGE_DIR } from "./paths.ts";

// Caller-facing input shapes: `t` (epoch ms) is ALWAYS caller-supplied -- the
// store does NOT default it -- and there is NO `v`: the store owns the schema
// version and stamps v:1 itself at serialization time.
export type SignalInput =
  | { t: number; kind: "tool"; surface: string; tool: string; ok: boolean }
  | { t: number; kind: "sms_rx" | "sms_tx" | "mail_rx" | "mail_tx"; counterpart: string };

// The persisted line: SignalInput plus the store-owned version. Readers (the
// host exporter) count a line only when v is exactly the integer 1.
export type SignalEvent = { v: 1 } & SignalInput;

function usageDir(): string {
  return process.env.USAGE_DIR_OVERRIDE || USAGE_DIR;
}

function clamp(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) : s;
}

// Best-effort append -- never throws into a send or a run (metering must not
// break the thing being metered); on failure log one line and return. `v: 1` is
// stamped LAST, after the input spread: JSON.stringify keeps insertion order,
// so a caller that smuggles a `v` through `unknown`/`any` (TypeScript's
// excess-property protection vanishes at runtime) cannot override the
// store-owned version -- last writer wins.
export function recordSignal(input: SignalInput): void {
  try {
    const dir = usageDir();
    mkdirSync(dir, { recursive: true });
    const line =
      input.kind === "tool"
        ? JSON.stringify({ ...input, surface: clamp(input.surface), tool: clamp(input.tool), v: 1 })
        : JSON.stringify({ ...input, counterpart: clamp(input.counterpart), v: 1 });
    appendFileSync(join(dir, "signals.jsonl"), line + "\n");
  } catch (err) {
    console.error(`usage: signal append failed (${(err as Error).message})`);
  }
}
