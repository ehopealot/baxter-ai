// "Fast Baxter" brain (phase 3): the low-latency decision layer between the ears
// (whisper transcript) and the mouth (Piper). ONE model call with ONE tool: the
// model either answers briefly (spoken aloud) or calls dispatch_to_baxter(task) to
// hand real work to the full text Baxter (which runs in parallel and posts to the
// linked text channel). Deliberately NOT the agentic runner -- a single
// chat/completions turn keeps voice responsive; we intercept the tool call
// ourselves rather than letting an agent loop execute it.
//
// In-family: OpenRouter chat/completions (the same provider the live harness uses),
// default model = OPENROUTER_MODEL (minimax). See the 2026-07-18 voice spec.

export const VOICE_BRAIN_SYSTEM =
  "You are Fast Baxter, the speaking voice of Baxter in a Discord voice call. Someone just talked to you; the text is a speech transcript and may have small errors. " +
  "DECIDE FIRST: are they talking TO YOU? Respond when someone addresses you -- uses your name, greets you, or asks you a direct question (\"Hey Baxter, how are you?\", \"what's the capital of France?\"). Stay silent for everything else: acknowledgements (\"thanks\", \"ok\", \"cool\", \"bye\"), thinking-out-loud, people talking to each other, or background TV/noise. When you stay silent, reply with a COMPLETELY EMPTY message -- zero characters. NEVER write \"no response\", \"no comment\", \"(silence)\", \"nothing to add\", or any placeholder text; an empty string is the ONLY way to stay quiet. " +
  "When you ARE clearly being asked something: you CANNOT look anything up, browse the web, check email/calendar/files, run code, schedule things, or know anything current, time-sensitive, or personal beyond THIS conversation and the shared memory below -- you have no live information. " +
  "Answer directly ONLY when it's (a) timeless general knowledge (a capital city, simple math, a definition), or (b) plainly in this conversation or the shared memory. Then reply with a SHORT spoken answer: one or two sentences, conversational, no markdown, no lists, no emoji. " +
  "For ANYTHING else -- current events, scores, weather, news, prices, someone's schedule or plans, specific real-world facts you aren't certain of, or any lookup, action, reminder, or task -- you MUST call dispatch_to_baxter with a clear self-contained task AND set `kind` (\"question\" if they're asking for information, \"task\" if they want you to do or act on something). " +
  "NEVER guess, make something up, or answer from stale/uncertain knowledge -- if it needs current or specific info you don't plainly have, DISPATCH. When in doubt, dispatch. Keep everything short and natural for speech.";

// The single tool. `task` is a self-contained instruction handed to the full agent.
export const DISPATCH_TOOL = {
  type: "function",
  function: {
    name: "dispatch_to_baxter",
    description:
      "Hand a task to the full Baxter agent (which has tools, memory, web access, code execution, and scheduling). It works asynchronously and posts the result to the text channel. Use this for anything you cannot answer instantly from general knowledge.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "A clear, self-contained description of what to do, phrased so the agent needs no extra context." },
        kind: { type: "string", enum: ["question", "task"], description: "\"question\" if the person is asking for information or an answer (\"who's leading the Open?\", \"what's the weather?\"); \"task\" if they want you to DO or act on something (\"book a table\", \"remind me at 5\", \"send them an email\")." },
      },
      required: ["task", "kind"],
    },
  },
};

// Models often emit a PLACEHOLDER ("no response", "(silence)", "no comment")
// instead of a truly empty message when they mean to stay quiet -- Fast Baxter must
// not speak those aloud. True iff `text` is real speech, not such a placeholder.
// Only UNAMBIGUOUS placeholders -- not "no thanks"/"none"/"nothing" (real short
// answers). Matches the Unicode ellipsis (…) as well as ASCII "...".
// After a matched placeholder BODY, accept any trailing run of punctuation/symbols/
// whitespace (\p{P}\p{S}\s -- can't match letters/digits, so real content like "No
// response, but seriously" is untouched). Implements the rule directly instead of
// enumerating punctuation, which never converged.
const NON_ANSWER_RE = /^\(?\s*(no\s+(response|reply|comment|answer)(\s+(needed|necessary|required))?|nothing\s+to\s+(add|say)|silen(ce|t)|n\/a|--+|\.{3,}|…+)[\p{P}\p{S}\s]*$/iu;
export function isSpeakableAnswer(text) {
  const t = String(text ?? "").trim();
  return Boolean(t) && !NON_ANSWER_RE.test(t);
}

// Turn a chat/completions assistant message into a decision. A dispatch_to_baxter
// tool call -> {action:"dispatch", task, ack}; otherwise -> {action:"speak", text}.
// Pure + tested; tolerant of malformed tool args (bad JSON -> empty task, caller
// decides). Exported separately from the network call so the branching is testable.
export function parseBrainDecision(message) {
  const call = message?.tool_calls?.find?.((c) => c?.function?.name === "dispatch_to_baxter");
  if (call) {
    let task = "";
    let kind = "task"; // default: a plain "On it." if the model omits/mangles kind
    try {
      const args = JSON.parse(call.function?.arguments || "{}");
      task = String(args.task ?? "").trim();
      if (args.kind === "question" || args.kind === "task") kind = args.kind;
    } catch {
      task = "";
    }
    return { action: "dispatch", task, kind, ack: String(message?.content ?? "").trim() };
  }
  return { action: "speak", text: String(message?.content ?? "").trim() };
}

// Ask the fast brain what to do with a transcript. Resolves a decision (see
// parseBrainDecision). `context` is a short rolling history (chat messages).
// fetchFn injectable for tests; network/HTTP errors reject so the caller logs+skips.
export async function decide(transcript, { model, apiKey, baseUrl = "https://openrouter.ai/api/v1", context = [], memory = "", maxTokens = 300, timeoutMs = 15_000, fetchFn = fetch } = {}) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  if (!model) throw new Error("voice brain model is not set");
  // Read-only shared memory injected as context so Fast Baxter can answer "who/what
  // do you know" instantly and route well; it's capped by the caller, and deeper
  // recall belongs in a dispatch (see the 2026-07-18 voice spec, phase-3 memory note).
  const system = memory
    ? `${VOICE_BRAIN_SYSTEM}\n\nWhat Baxter already knows (shared memory, may be partial -- for anything deeper, dispatch it):\n${memory}`
    : VOICE_BRAIN_SYSTEM;
  const messages = [
    { role: "system", content: system },
    ...context,
    { role: "user", content: String(transcript ?? "") },
  ];
  // Bound the call -- this is the latency-critical voice path; a stalled response
  // must abort (and the caller logs) rather than answer minutes late out of context.
  const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools: [DISPATCH_TOOL], tool_choice: "auto", max_tokens: maxTokens }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`brain HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  if (!message) throw new Error("brain: no choices in response");
  return parseBrainDecision(message);
}
