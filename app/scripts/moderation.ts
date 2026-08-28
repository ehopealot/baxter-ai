// Optional content moderation via OpenAI's /v1/moderations endpoint (a dedicated, free content
// classifier) on messages IN (Discord + email) and OUT (Baxter's replies).
// See docs/superpowers/specs/2026-08-01-openai-moderation-backend-design.md.
//
// Each check is ONE call to the moderations endpoint: the single message (no thread, no
// transcript) -> per-category scores. Free + fast (~100-300ms) + timeout-resistant. OFF by
// default; enabled per-env. Design posture: FAIL-OPEN. A disabled check, a misconfig, or an
// endpoint error/timeout all resolve to ALLOWED (with a loud alert on the error paths) -- a
// family tool must not go silent because the moderation provider hiccuped. This is CONTENT
// moderation layered on top of the surfaces' existing sender/recipient ALLOWLISTS, not the access
// boundary, and not prompt-injection defense (the transcript sanitizer's job). A dedicated
// classifier isn't an injection surface either -- it scores content, it can't be instructed by it.
//
// No dependency on runtime.ts (kept light so the send-CLIs can import it cheaply); logging/alert
// is an injected callback, defaulting to console.error. Provider traffic still uses the
// shared lease boundary so worker revocation applies to moderation too.
import { isLeaseRevokedError, LeaseRevokedError, providerFetch } from "./provider-lease-transport.ts";

export type Direction = "in" | "out";
export interface Verdict { allowed: boolean; category?: string; reason?: string; }

// Our coarse verdict categories (they drive the canned inbound replies). OpenAI's finer category
// ids map onto these; anything unmapped folds to "other".
// (No "profanity": OpenAI's endpoint has no such category, so toVerdictCategory never yields it;
// heavy profanity surfaces via `harassment` scores.)
export const CATEGORIES = ["harassment", "sexual", "violence", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
const isCategory = (s: string): s is Category => (CATEGORIES as readonly string[]).includes(s);
const toCategory = (raw: string | undefined): Category => { const lc = (raw || "").toLowerCase(); return isCategory(lc) ? lc : "other"; };

export interface ModConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  hardThreshold: number; // clearly-unsafe categories block at/above this (a WEAK signal is enough)
  softThreshold: number; // everything else needs a STRONG signal (family-lenient)
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "omni-moderation-latest";
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_HARD_THRESHOLD = 0.5;
const DEFAULT_SOFT_THRESHOLD = 0.85;

// Is moderation on for this direction? Master MODERATION_ENABLED gate + an optional per-direction
// opt-OUT (MODERATION_INBOUND / MODERATION_OUTBOUND set to "0"). Off by default.
export function moderationEnabled(direction: Direction, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MODERATION_ENABLED !== "1") return false;
  const perDir = direction === "in" ? env.MODERATION_INBOUND : env.MODERATION_OUTBOUND;
  return perDir !== "0";
}

// Parse a numeric env value, falling back to a default on blank/NaN/below-min. Blank is
// checked FIRST: Number("") is 0, which for a threshold (min 0) would silently pass 0 >= 0
// and block every message (fail-CLOSED) -- the opposite of this module's fail-open posture.
function envNum(raw: string | undefined, dflt: number, min = 0): number {
  if (!raw || !raw.trim()) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : dflt;
}

export function loadModConfig(env: NodeJS.ProcessEnv = process.env): ModConfig {
  return {
    apiKey: (env.MODERATION_OPENAI_API_KEY || "").trim(),
    model: (env.MODERATION_OPENAI_MODEL || DEFAULT_MODEL).trim(),
    baseUrl: (env.MODERATION_OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    timeoutMs: envNum(env.MODERATION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1),
    hardThreshold: envNum(env.MODERATION_HARD_THRESHOLD, DEFAULT_HARD_THRESHOLD),
    softThreshold: envNum(env.MODERATION_SOFT_THRESHOLD, DEFAULT_SOFT_THRESHOLD),
  };
}

// One moderation result from OpenAI: per-category booleans + 0..1 scores. We classify off the
// SCORES against our own family-lenient thresholds, not the endpoint's own stricter `flagged`.
export interface OpenAiModerationResult {
  flagged?: boolean;
  categories?: Record<string, boolean>;
  category_scores?: Record<string, number>;
}

// The clearly-unsafe categories: block on a WEAK signal (hardThreshold). Everything else is a soft
// category, blocked only on a STRONG signal (softThreshold) so ordinary family banter isn't
// censored. Membership is a safety stance, not routine tuning, so it lives in code, not env.
const HARD_CATEGORIES = new Set(["sexual/minors", "hate/threatening", "violence/graphic", "self-harm/instructions"]);

// Map an OpenAI category id onto our coarse Verdict category (which picks the canned reply).
function toVerdictCategory(openAiCat: string): Category {
  if (openAiCat.startsWith("sexual")) return "sexual";
  if (openAiCat.startsWith("harassment") || openAiCat.startsWith("hate")) return "harassment";
  if (openAiCat.startsWith("violence")) return "violence";
  return "other"; // self-harm, illicit, anything else
}

// Pure: turn an OpenAI moderation result into a Verdict via the threshold policy. Blocks on the
// highest-scoring category that crosses its threshold (hard categories at hardThreshold, the rest
// at softThreshold); if nothing crosses, ALLOW. We deliberately do NOT trust the endpoint's bare
// `flagged`, which is stricter than a family channel wants. Defensive: a missing/garbled
// category_scores yields ALLOW (fail-toward-allow).
export function classifyOpenAiResult(result: OpenAiModerationResult, cfg: ModConfig): Verdict {
  const scores = result?.category_scores ?? {};
  let worst: { cat: string; score: number } | null = null;
  for (const [cat, s] of Object.entries(scores)) {
    if (typeof s !== "number" || !Number.isFinite(s)) continue;
    const threshold = HARD_CATEGORIES.has(cat) ? cfg.hardThreshold : cfg.softThreshold;
    if (s >= threshold && (!worst || s > worst.score)) worst = { cat, score: s };
  }
  if (!worst) return { allowed: true };
  return { allowed: false, category: toVerdictCategory(worst.cat), reason: `${worst.cat} ${worst.score.toFixed(2)}` };
}

// The low-level endpoint call, injectable so the whole module is unit-testable with no network.
// Returns the single moderation result. Default impl: POST OpenAI's /v1/moderations.
export type ModerationCall = (text: string, cfg: ModConfig, signal: AbortSignal) => Promise<OpenAiModerationResult>;

export const callOpenAiModeration: ModerationCall = async (text, cfg, signal) => {
  const res = await providerFetch(`${cfg.baseUrl}/moderations`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, input: text }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(error => { if (isLeaseRevokedError(error)) throw error; return ""; });
    throw new Error(`moderation HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { results?: OpenAiModerationResult[] };
  const result = json.results?.[0];
  if (!result) throw new Error("moderation response had no results");
  return result;
};

export interface ModerateOpts {
  env?: NodeJS.ProcessEnv;
  call?: ModerationCall;
  alert?: (msg: string) => void;
}

// The entry point the hook sites use. Returns a Verdict. FAIL-OPEN throughout: disabled or empty
// text -> allow with no call; a misconfig (no key) -> allow + one alert; an endpoint error/timeout
// -> allow + alert. moderate() owns the timeout (one AbortController from cfg.timeoutMs).
export async function moderate(text: string, direction: Direction, opts: ModerateOpts = {}): Promise<Verdict> {
  const env = opts.env ?? process.env;
  const alert = opts.alert ?? ((m: string) => console.error(m));
  const dir = direction === "in" ? "inbound" : "outbound";
  if (!moderationEnabled(direction, env)) return { allowed: true };
  if (!text || !text.trim()) return { allowed: true }; // nothing to check (e.g. a file-only post)

  const cfg = loadModConfig(env);
  if (!cfg.apiKey) {
    alert(`moderation ALERT: MODERATION_ENABLED but MODERATION_OPENAI_API_KEY is unset -- allowing ${dir} unchecked`);
    return { allowed: true };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const call = opts.call ?? callOpenAiModeration;
    return classifyOpenAiResult(await call(text, cfg, controller.signal), cfg);
  } catch (err) {
    // A provider failure is fail-open content policy. Worker authority loss is
    // not a provider failure and must fence the entire caller instead.
    if (err instanceof LeaseRevokedError || (err as Error)?.name === "LeaseRevokedError") throw err;
    alert(`moderation ALERT: moderation call failed (${(err as Error).message}) -- allowing ${dir} unchecked (fail-open)`);
    return { allowed: true };
  } finally {
    clearTimeout(timer);
  }
}

// ---- responses to a block ----

// Canned inbound replies, chosen by the block category (a few friendly variants each). Delivered
// by the daemon directly, so they bypass the outbound check (our own safe text). Editable here.
const INBOUND_REPLIES: Record<Category, string[]> = {
  harassment: ["I'd rather not engage with that — let's keep it kind.", "Let's keep things respectful 🙂"],
  sexual: ["That's not something I can help with here.", "I'll sit that one out — let's keep it family-friendly."],
  violence: ["I can't help with that one.", "Let's steer clear of that — happy to help with something else."],
  other: ["I can't help with that one, but I'm happy to help with something else!", "Let's keep it friendly 🙂 — what else can I do?"],
};

// Pick a canned inbound reply for a category. `pick` (0..1) selects a variant deterministically
// in tests; defaults to random.
export function inboundBlockReply(category: string | undefined, pick: number = Math.random()): string {
  const variants = INBOUND_REPLIES[toCategory(category)];
  const i = Math.min(variants.length - 1, Math.max(0, Math.floor(pick * variants.length)));
  return variants[i];
}

// The structured error the send-CLI returns to the agent on an outbound block: do NOT resend,
// apologize/decline instead -- so the user hears the decline in Baxter's own voice.
export function outboundBlockNotice(reason?: string): string {
  return `blocked by the safety filter${reason ? ` (${reason})` : ""} -- do NOT resend this message. Instead, send a brief, polite reply that you can't help with that.`;
}
