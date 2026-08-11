// Member-welcome email for the home surface. When the family adds a NEW email member in the home
// settings UI, the DO sends a { kind:"member-welcome", email, name } COMMAND down the checklist
// link (same shape as sort-list); home-bot dispatches it here.
//
// This is a TRANSACTIONAL/system email -- the family explicitly added the person -- not an
// agent-authored send. So it does NOT go through mail-cli's model-send policy (the injection scan
// on outbound BODY text, the agent send-cap): those guard what the *model* emits, and the body
// here is a fixed template. It DOES gate on the recipient being a currently-allowlisted member
// (containment: a stray/buggy address that isn't a member is dropped), and it sends from the
// household's own address (BAXTER_EMAIL = <household>@<domain>) so a reply threads back to the
// mail surface. Sending is one scoped HTTPS POST to Resend (like calendar polling / Sort's model
// call) -- no agent run, honouring the home surface's no-LLM invariant.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "./calendar-cli.ts";

// Templates ship WITH the code (core/app/emails), the single source of truth baxctl also reads.
// Resolved relative to this module so it works from the container's app/ dir.
const EMAILS_DIR = fileURLToPath(new URL("../emails/", import.meta.url));

export interface MemberWelcomePayload { kind: "member-welcome"; email: string; name?: string; }

// Trusted only from the SigV4-verified DO link, but shape-validated here like home-link's
// isIntentLike / home-sort's isSortListCommand: email must be a string; name string-or-absent.
export function isMemberWelcomeCommand(p: unknown): p is MemberWelcomePayload {
  if (typeof p !== "object" || p === null) return false;
  const o = p as { kind?: unknown; email?: unknown; name?: unknown };
  return o.kind === "member-welcome"
    && typeof o.email === "string"
    && (o.name === undefined || typeof o.name === "string");
}

// A minimal, attribute-safe HTML escape for the values substituted into welcome.html (a member
// nickname is free-form family input; every other value is our own construction). Covers the
// five characters that matter in both element and double-quoted-attribute contexts.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// {{var}} substitution. `escape` HTML-escapes each value (welcome.html); false passes raw
// (welcome.txt). An unknown placeholder renders empty -- never leave a literal {{x}} in a sent
// email. \w+ matches the template's snake_case names (assistant_phone_e164 etc.).
export function renderTemplate(tpl: string, vars: Record<string, string>, escape: boolean): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined) return "";
    return escape ? escapeHtml(v) : v;
  });
}

// welcome.txt leads with a `Subject: ...` line (the ONE place the subject is defined, so it stays
// with the copy). Split it off: the returned body is what gets sent as text/plain, subject-free.
export function parseSubjectAndBody(txt: string): { subject: string; body: string } {
  const m = txt.match(/^Subject:[ \t]*(.*)(?:\r?\n)/);
  if (!m) return { subject: "Baxter is set up", body: txt };
  return { subject: m[1].trim() || "Baxter is set up", body: txt.slice(m[0].length).replace(/^(?:\r?\n)+/, "") };
}

// Display form of the assistant's E.164 number for the "Text me" line. US (+1NXXNXXXXXX) gets the
// familiar grouping; anything else is shown verbatim (never guess a foreign format).
export function formatPhoneDisplay(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164;
}

// The transport: one Resend send. Injected (default makeResendSender) so the whole command path is
// hermetically testable with a fake. Throws on a non-2xx so the caller logs it.
export type WelcomeSender = (msg: { from: string; to: string; subject: string; html: string; text: string }) => Promise<void>;

export function makeResendSender(apiKey: string, fetchImpl: FetchLike): WelcomeSender {
  return async ({ from, to, subject, html, text }) => {
    // Bounded like every other outbound call on this surface -- a hung route must not leave this
    // fire-and-forget promise pending for undici's ~300s default.
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject, html, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`resend send failed: HTTP ${res.status}`);
    // Nothing reads the body; release the stream so it isn't left open.
    res.body?.cancel().catch(() => {});
  };
}

export interface WelcomeContext {
  from: string;                  // BAXTER_EMAIL -- <household>@<domain>; also the source of `household`
  phoneE164: string;             // SENDBLUE_FROM_NUMBER, or "" when the fleet has no SMS number
  homeUrl: string;               // https://home.<domain> (the {{home_url}} button), or ""
  isAllowedRecipient: (email: string) => boolean; // member-containment gate (loadAllowlist-backed)
  loadTemplates?: () => { html: string; text: string }; // injectable; default reads EMAILS_DIR
}

export function loadWelcomeTemplates(dir: string = EMAILS_DIR): { html: string; text: string } {
  return {
    html: readFileSync(join(dir, "welcome.html"), "utf8"),
    text: readFileSync(join(dir, "welcome.txt"), "utf8"),
  };
}

// Handle a member-welcome command: validate, gate on membership, render, send. Every moot/bad case
// (malformed payload, no BAXTER_EMAIL to send from, recipient not an allowlisted member) and any
// error is swallowed+logged -- never thrown -- so a bad command can't crash the standing surface.
export async function sendMemberWelcome(
  payload: unknown,
  ctx: WelcomeContext,
  send: WelcomeSender,
  logFn: (m: string) => void,
  logErrFn: (m: string) => void,
): Promise<void> {
  if (!isMemberWelcomeCommand(payload)) { logErrFn("home: ignoring malformed member-welcome command payload"); return; }
  try {
    if (!ctx.from) { logErrFn("home: member-welcome skipped -- no BAXTER_EMAIL to send from"); return; }
    // Containment: only email an address the family has actually made a member (it is, once the
    // members snapshot that precedes this command on the link has applied). A stray address is
    // dropped rather than mailed.
    if (!ctx.isAllowedRecipient(payload.email)) {
      logFn(`home: member-welcome for a non-member address -- skipped`);
      return;
    }
    const household = ctx.from.split("@")[0] || ctx.from;
    const { html: htmlTpl, text: textTpl } = (ctx.loadTemplates ?? loadWelcomeTemplates)();
    const { subject, body: textBody } = parseSubjectAndBody(textTpl);
    const vars: Record<string, string> = {
      name: (payload.name ?? "").trim() || "there",
      household,
      assistant_phone: ctx.phoneE164 ? formatPhoneDisplay(ctx.phoneE164) : "",
      assistant_phone_e164: ctx.phoneE164,
      home_url: ctx.homeUrl,
    };
    await send({
      from: `Baxter <${ctx.from}>`,
      to: payload.email,
      subject,
      html: renderTemplate(htmlTpl, vars, true),
      text: renderTemplate(textBody, vars, false),
    });
    logFn(`home: sent member-welcome to a new member`);
  } catch (err) {
    logErrFn(`home: member-welcome command failed: ${(err as Error).message}`);
  }
}
