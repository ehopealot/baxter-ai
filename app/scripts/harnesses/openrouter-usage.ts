// Pure per-turn usage accumulator for the openrouter runner. A run is many billed
// turns across possibly several callModel invocations (main loop + escalation
// resume + the nudge's separate direct call); the runner feeds each turn's usage
// here and reports the sum. Pure over plain objects so the no-double-count +
// token-only behavior is tested offline (the runner can't be unit-tested against
// the live SDK). Field names match the SDK's Usage (inputTokens/outputTokens/cost).
import type { UsageReport } from "./runner-events.ts";

export interface TurnUsage {
  cost?: number | null;
  inputTokens?: number;
  outputTokens?: number;
}
export interface UsageAccum {
  cost: number;
  inTok: number;
  outTok: number;
  haveCost: boolean;
}

export function emptyAccum(): UsageAccum {
  return { cost: 0, inTok: 0, outTok: 0, haveCost: false };
}

export function addTurnUsage(acc: UsageAccum, u: TurnUsage | undefined | null): void {
  if (!u) return;
  if (typeof u.cost === "number" && Number.isFinite(u.cost)) {
    acc.cost += u.cost;
    acc.haveCost = true;
  }
  acc.inTok += u.inputTokens ?? 0;
  acc.outTok += u.outputTokens ?? 0;
}

// haveCost distinguishes "no turn ever reported a cost" (-> null, which trips the
// runtime null-cost guard) from a genuine $0.00 run.
export function finalizeUsage(acc: UsageAccum, model: string): UsageReport {
  return { cost: acc.haveCost ? acc.cost : null, inTok: acc.inTok, outTok: acc.outTok, src: "openrouter", model };
}
