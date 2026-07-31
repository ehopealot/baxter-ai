// Optional content moderation (verifier-model calls) on messages IN (Discord + email) and OUT
// (Baxter's replies). See docs/superpowers/specs/2026-07-31-moderation-design.md.
//
// Each check is ONE small model call: a fixed policy prompt (system, cacheable) + the single
// message (user) -- no thread, no transcript -- so it's cheap. OFF by default; enabled per-env.
// Design posture: FAIL-OPEN. A disabled check, a misconfig, a verifier error/timeout, or an
// unparseable verdict all resolve to ALLOWED (with a loud alert on the error paths) -- a family
// tool must not go silent because the moderation provider hiccuped. This is CONTENT moderation
// layered on top of the surfaces' existing sender/recipient ALLOWLISTS, not the access boundary,
// and not prompt-injection defense (that stays the transcript sanitizer's job).
//
// No dependency on runtime.ts (kept light so the send-CLIs can import it cheaply); logging/alert
// is an injected callback, defaulting to console.error.

export type Direction = "in" | "out";
export interface Verdict { allowed: boolean; category?: string; reason?: string; }

// The categories the verifier may return; anything else folds to "other".
export const CATEGORIES = ["profanity", "harassment", "sexual", "violence", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface ModConfig {
  model: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  inboundPrompt: string;
  outboundPrompt: string;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 4000;

const INBOUND_PROMPT =
  "You are a safety filter for a family assistant that receives messages from family members. " +
  "Decide whether the incoming message below is acceptable, or should be blocked as clearly " +
  "unsafe or offensive. Be lenient with ordinary casual chat, jokes, and mild language; only " +
  "block CLEARLY objectionable content (slurs/harassment, sexual content, threats or violence, " +
  "heavy profanity aimed at someone). Reply with EXACTLY one line: 'ALLOW', or " +
  "'BLOCK <category>: <brief reason>' where <category> is one of profanity, harassment, sexual, violence, other.";

const OUTBOUND_PROMPT =
  "You are a safety filter reviewing a reply a family assistant is about to send. Decide whether " +
  "it is acceptable to send, or should be blocked as clearly unsafe or offensive (slurs/harassment, " +
  "sexual content, threats or violence, heavy profanity). Be lenient with ordinary helpful, casual, " +
  "or mildly-worded replies; only block CLEARLY objectionable content. Reply with EXACTLY one line: " +
  "'ALLOW', or 'BLOCK <category>: <brief reason>' where <category> is one of profanity, harassment, sexual, violence, other.";

// Is moderation on for this direction? Master MODERATION_ENABLED gate + an optional per-direction
// opt-OUT (MODERATION_INBOUND / MODERATION_OUTBOUND set to "0"). Off by default.
export function moderationEnabled(direction: Direction, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MODERATION_ENABLED !== "1") return false;
  const perDir = direction === "in" ? env.MODERATION_INBOUND : env.MODERATION_OUTBOUND;
  return perDir !== "0";
}

export function loadModConfig(env: NodeJS.ProcessEnv = process.env): ModConfig {
  const n = Number(env.MODERATION_TIMEOUT_MS);
  return {
    model: (env.MODERATION_MODEL || "").trim(),
    apiKey: (env.MODERATION_API_KEY || env.OPENROUTER_API_KEY || "").trim(),
    baseUrl: (env.MODERATION_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    timeoutMs: Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS,
    inboundPrompt: env.MODERATION_INBOUND_PROMPT || INBOUND_PROMPT,
    outboundPrompt: env.MODERATION_OUTBOUND_PROMPT || OUTBOUND_PROMPT,
  };
}

// Parse the verifier's reply into a Verdict. Lenient: case-insensitive, tolerates surrounding
// text/markdown, and DEFAULTS TO ALLOW when it can't find a clear BLOCK verdict (a garbled reply
// must never silently censor). A BLOCK with an unrecognized category folds to "other".
function blockFrom(catRaw: string | undefined, reasonRaw: string | undefined): Verdict {
  const cat = (catRaw || "other").toLowerCase();
  const category: Category = (CATEGORIES as readonly string[]).includes(cat) ? (cat as Category) : "other";
  const reason = (reasonRaw || "").trim().replace(/\s+/g, " ").slice(0, 200) || undefined;
  return { allowed: false, category, reason };
}

// Parse the verifier's reply into a Verdict. The prompt asks for EXACTLY one line ('ALLOW' or
// 'BLOCK <category>: <reason>'), so prefer a line that IS a verdict -- whichever comes first
// wins, regardless of surrounding reasoning. If the model ignored the format entirely (a chatty
// blob with no verdict line), fall back to blocking ONLY on a VERDICT-SHAPED "BLOCK" (immediately
// followed by a known category or a ':'/'-' separator) -- so a mere mention of the word "block"
// ("no reason to block") never censors. Everything else DEFAULTS TO ALLOW (fail-toward-allow: a
// garbled reply must not silently censor).
export function parseVerdict(raw: string): Verdict {
  const text = String(raw ?? "");
  for (const line of text.split(/\r?\n/)) {
    const mv = line.match(/^\s*(ALLOW|BLOCK)\b\s*([a-z]+)?\s*[:\-]?\s*(.*)/i);
    if (!mv) continue;
    return mv[1].toUpperCase() === "ALLOW" ? { allowed: true } : blockFrom(mv[2], mv[3]);
  }
  const shaped = text.match(/\bBLOCK\b[ \t]*(?:(profanity|harassment|sexual|violence|other)\b|[:\-])[ \t]*(.*)/i);
  return shaped ? blockFrom(shaped[1], shaped[2]) : { allowed: true };
}

// The low-level verifier call, injectable so the whole module is unit-testable with no network.
// Returns the model's raw reply text. Default impl: an OpenAI-compatible chat/completions POST.
export type VerifierCall = (system: string, message: string, cfg: ModConfig) => Promise<string>;

export const defaultVerifier: VerifierCall = async (system, message, cfg) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "system", content: system }, { role: "user", content: message }],
        max_tokens: 24, // "BLOCK harassment: <brief>" fits; keep it tiny
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`verifier HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    return String(json.choices?.[0]?.message?.content ?? "");
  } finally {
    clearTimeout(timer);
  }
};

export interface ModerateOpts {
  env?: NodeJS.ProcessEnv;
  call?: VerifierCall;
  alert?: (msg: string) => void;
}

// The entry point the hook sites use. Returns a Verdict. FAIL-OPEN throughout: disabled or empty
// text -> allow with no call; a misconfig (no model/key) -> allow + one alert; a verifier
// error/timeout -> allow + alert; an unparseable reply -> allow (parseVerdict's default).
export async function moderate(text: string, direction: Direction, opts: ModerateOpts = {}): Promise<Verdict> {
  const env = opts.env ?? process.env;
  const alert = opts.alert ?? ((m: string) => console.error(m));
  if (!moderationEnabled(direction, env)) return { allowed: true };
  if (!text || !text.trim()) return { allowed: true }; // nothing to check (e.g. a file-only post)

  const cfg = loadModConfig(env);
  if (!cfg.model || !cfg.apiKey) {
    alert(`moderation ALERT: MODERATION_ENABLED but ${!cfg.model ? "MODERATION_MODEL" : "MODERATION_API_KEY/OPENROUTER_API_KEY"} is unset -- allowing ${direction === "in" ? "inbound" : "outbound"} unchecked`);
    return { allowed: true };
  }
  const system = direction === "in" ? cfg.inboundPrompt : cfg.outboundPrompt;
  const call = opts.call ?? defaultVerifier;
  try {
    return parseVerdict(await call(system, text, cfg));
  } catch (err) {
    alert(`moderation ALERT: verifier call failed (${(err as Error).message}) -- allowing ${direction === "in" ? "inbound" : "outbound"} unchecked (fail-open)`);
    return { allowed: true };
  }
}

// ---- responses to a block ----

// Canned inbound replies, chosen by the block category (a few friendly variants each). Delivered
// by the daemon directly, so they bypass the outbound check (our own safe text). Editable here.
const INBOUND_REPLIES: Record<Category, string[]> = {
  profanity: ["Let's keep it clean 🙂", "Whoa, let's keep it friendly — mind rephrasing?"],
  harassment: ["I'd rather not engage with that — let's keep it kind.", "Let's keep things respectful 🙂"],
  sexual: ["That's not something I can help with here.", "I'll sit that one out — let's keep it family-friendly."],
  violence: ["I can't help with that one.", "Let's steer clear of that — happy to help with something else."],
  other: ["I can't help with that one, but I'm happy to help with something else!", "Let's keep it friendly 🙂 — what else can I do?"],
};

// Pick a canned inbound reply for a category. `pick` (0..1) selects a variant deterministically
// in tests; defaults to random.
export function inboundBlockReply(category: string | undefined, pick: number = Math.random()): string {
  const cat: Category = (CATEGORIES as readonly string[]).includes(String(category)) ? (category as Category) : "other";
  const variants = INBOUND_REPLIES[cat];
  const i = Math.min(variants.length - 1, Math.max(0, Math.floor(pick * variants.length)));
  return variants[i];
}

// The structured error the send-CLI returns to the agent on an outbound block: do NOT resend,
// apologize/decline instead -- so the user hears the decline in Baxter's own voice.
export function outboundBlockNotice(reason?: string): string {
  return `blocked by the safety filter${reason ? ` (${reason})` : ""} -- do NOT resend this message. Instead, send a brief, polite reply that you can't help with that.`;
}
