// Home Chats auto-titling -- a dedicated, cheap single-shot OpenRouter call
// that names a new chat from its first message (Claude/ChatGPT-style
// auto-title). Deliberately NOT the agentic runAgent (harnesses/*): that's a
// heavy tool-calling loop meant for a full conversational turn, wildly
// overkill (and slow/expensive) for producing a six-word label. This talks to
// OpenRouter directly, mirroring the key/URL/model-env conventions
// harnesses/openrouter-runner.ts uses (OPENROUTER_API_KEY /
// https://openrouter.ai/api/v1 / OPENROUTER_MODEL), but with its own cheaper
// model override (CHAT_TITLE_MODEL) so titling doesn't have to spend the
// main chat model's price on every new conversation. openrouter-only, per
// the harness-layer's fleet posture -- see app/scripts/harnesses/CLAUDE.md.
import { cleanForPrompt } from "./transcript.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Narrower than `typeof fetch` (which accepts `string | Request | URL`), so a
// test double typed with a plain `string` url param stays assignable -- the
// global `fetch` itself still satisfies this narrower shape. Mirrors
// sms-cli.ts's FetchFn.
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
export interface TitleDeps { fetchImpl?: FetchFn; }

// Cap the rendered title, and bound the whole call so a slow/hung OpenRouter
// route can never stall the chat-bot waiting on a title -- titling is a nice-
// to-have, never worth blocking a reply on. Small max_tokens keeps the call cheap.
const TITLE_MAX = 48;
const TIMEOUT_MS = 6000;
const MAX_TOKENS = 24;

const SYSTEM_PROMPT =
  "Return a concise title of at most 6 words for this conversation. No quotes, no punctuation-only, plain text.";

// Human-readable local-time fallback, e.g. "Chat · Aug 5, 3:41 PM" -- used
// whenever the model call can't produce a usable title (missing config,
// network error, timeout, non-2xx, or an empty/whitespace completion).
// titleFor must NEVER throw, so this is the unconditional safety net.
// "Local" means the household's timezone, not the container's -- the fleet
// runs UTC by default (no TZ in compose.yaml), so this reuses the repo's
// established BAXTER_TZ/HEARTBEAT_TZ convention (voice-brain.ts,
// harnesses/runner-common.ts) rather than the bare (container-local)
// toLocaleString default. toLocaleString throws a RangeError on an invalid
// timeZone (e.g. a typo'd BAXTER_TZ), so -- same as those two precedent
// sites -- a bad tz degrades to container-local rather than throwing: this
// function's own contract (never throw) can't tolerate an env typo blowing
// up titleFor's catch block, which is what calls this in the first place.
function fallbackTitle(now: Date = new Date()): string {
  const tz = process.env.BAXTER_TZ || process.env.HEARTBEAT_TZ || "America/Los_Angeles";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  let formatted: string;
  try {
    formatted = now.toLocaleString("en-US", { ...opts, timeZone: tz });
  } catch {
    formatted = now.toLocaleString("en-US", opts); // bad tz -> container-local rather than throwing
  }
  return `Chat · ${formatted}`;
}

// Trim, strip one layer of surrounding quotes (straight or curly) and any
// newlines, collapse internal whitespace, cap to TITLE_MAX. Returns "" if
// nothing usable survives -- the caller then falls back to fallbackTitle().
function postProcess(raw: string): string {
  let s = String(raw ?? "").replace(/[\r\n]+/g, " ").trim();
  s = s.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX).trim();
  return s;
}

// Name a new chat from its first message. `firstMessage` is family-authored
// (or, on a shared/compromised device, attacker-influenced) so it's run
// through cleanForPrompt -- the same transcript-forgery sanitization every
// other untrusted-text-into-a-prompt path in this repo uses -- before ever
// reaching the model. `fetchImpl` is injectable for tests (default: global
// fetch), mirroring sms-cli.ts's FetchFn pattern.
export async function titleFor(firstMessage: string, deps: TitleDeps = {}): Promise<string> {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.CHAT_TITLE_MODEL || process.env.OPENROUTER_MODEL;
    if (!apiKey || !model) return fallbackTitle();
    const f: FetchFn = deps.fetchImpl ?? fetch;
    const res = await f(OPENROUTER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: cleanForPrompt(firstMessage) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return fallbackTitle();
    const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
    const raw = data?.choices?.[0]?.message?.content ?? "";
    const title = postProcess(raw);
    return title || fallbackTitle();
  } catch {
    // Network error, timeout (AbortSignal.timeout rejects with an AbortError),
    // or any unexpected shape -- titling must never throw into the chat-bot.
    return fallbackTitle();
  }
}
