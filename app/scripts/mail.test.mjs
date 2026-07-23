// TDD (red until implemented): tests for the AgentMail adapter (mail.mjs), the
// gmail.mjs replacement. Pure logic only -- an injected fake client, no network.
// See docs/superpowers/specs/2026-07-22-agentmail-migration-design.md.
//
// Timestamps are epoch-ms integers here: the pure cores (classifyListing /
// buildThreadOutput) work in ms, and the thin I/O wrapper converts AgentMail's
// ISO `timestamp` <-> ms and back for the `after` query + cursor persistence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROCESSED_LABEL,
  SENT_LABEL,
  loadApiKey,
  listOpts,
  canonicalMessageId,
  classifyListing,
  detectAutomated,
  buildThreadOutput,
  buildSendArgs,
  buildReplyArgs,
  operatorRecipient,
  performSend,
  performReply,
} from "./mail.mjs";
import { TRIGGER_MARKER } from "./transcript.mjs";

const OWN = "baxter@agentmail.to";
const ALLOW = ["alice@x.com"];
const count = (h, n) => h.split(n).length - 1;

// list-message shape (what messages.list returns, mapped to ms)
const lmsg = (id, ts, from, labels = []) => ({ messageId: id, threadId: "th-" + id, from, timestamp: ts, labels });
// full-message shape (what messages.get / a thread's messages carry)
const fmsg = (id, ts, from, text, { labels = [], headers = {}, subject = "Subj" } = {}) =>
  ({ messageId: id, threadId: "T", from, subject, text, timestamp: ts, labels, headers });

// ---- credential loader (mirrors discord-cli.mjs token(): env-first-then-file) ----

test("loadApiKey prefers env, falls back to the 0600 file, else throws", () => {
  assert.equal(loadApiKey({ AGENTMAIL_API_KEY: "envkey" }, "/nonexistent.json"), "envkey");

  const dir = mkdtempSync(join(tmpdir(), "am-key-"));
  const p = join(dir, "agentmail-key.json");
  writeFileSync(p, JSON.stringify({ apiKey: "filekey" }));
  assert.equal(loadApiKey({}, p), "filekey"); // env absent -> read the file
  assert.equal(loadApiKey({ AGENTMAIL_API_KEY: "envkey" }, p), "envkey"); // BOTH present -> env WINS (a rotated .env beats a stale 0600 file)
  assert.throws(() => loadApiKey({}, join(dir, "missing.json")), /AGENTMAIL_API_KEY/); // neither
  rmSync(dir, { recursive: true, force: true });
});

test("listOpts passes `after` as a Date OBJECT (the SDK rejects an ISO string) and omits an empty pageToken", () => {
  const o = listOpts(0);
  assert.ok(o.after instanceof Date, "after must be a Date -- the agentmail SDK type-checks it, an ISO string fails live");
  assert.equal(o.after.getTime(), 0); // cursor ms -> Date
  assert.equal(o.ascending, true);
  assert.ok(!("pageToken" in o), "no pageToken key when unpaged (undefined would fail the SDK's string check)");
  assert.equal(listOpts(5000, "tok").pageToken, "tok"); // included when present
});

test("canonicalMessageId re-adds the angle brackets a model strips off an RFC Message-ID", () => {
  // The reply 404 seen live: the model dropped the <> from `<id@host>` -> "Message not found".
  assert.equal(canonicalMessageId("CAOob4qK=x@mail.gmail.com"), "<CAOob4qK=x@mail.gmail.com>");
  assert.equal(canonicalMessageId("<CAOob4qK=x@mail.gmail.com>"), "<CAOob4qK=x@mail.gmail.com>"); // idempotent
  assert.equal(canonicalMessageId("  <a@b>  "), "<a@b>"); // trims surrounding whitespace
  assert.equal(canonicalMessageId("<a@b"), "<a@b>"); // HALF-stripped (leading bracket only)
  assert.equal(canonicalMessageId("a@b>"), "<a@b>"); // HALF-stripped (trailing bracket only)
  assert.equal(canonicalMessageId("7a000d91-cc2c-4b56-9242"), "7a000d91-cc2c-4b56-9242"); // UUID-style (no @) untouched
});

// ---- list-new classification + the conservative cursor (spec Finding 1) ----

test("classifyListing fails closed: empty ALLOWED_SENDERS yields no survivors", () => {
  const { survivors } = classifyListing({
    messages: [lmsg("a", 10, "alice@x.com")],
    prevCursor: 0, allowedSenders: [], ownEmail: OWN, margin: 1,
  });
  assert.deepEqual(survivors, []);
});

test("classifyListing ISOLATES each exclusion branch (processed / own-label / own-from / off-allowlist)", () => {
  // OWN is put ON the allowlist here so the OWN branches -- not the off-allowlist
  // branch -- are what exclude `s` and `f`. Otherwise an implementation with no
  // own-exclusion at all would still pass (they'd fall out as off-allowlist anyway),
  // and this is the only test pinning the loop-prevention "never process own mail".
  const messages = [
    lmsg("p", 10, "alice@x.com", [PROCESSED_LABEL]),   // excluded ONLY by the processed label
    lmsg("s", 20, "Alice <alice@x.com>", [SENT_LABEL]),// allowed From, excluded ONLY by the baxter-sent label
    lmsg("f", 30, OWN, []),                            // allowed From (OWN is listed), excluded ONLY by own-from
    lmsg("o", 40, "mallory@evil.com", []),             // excluded ONLY by off-allowlist
    lmsg("g", 50, "Alice <alice@x.com>", []),          // survivor
  ];
  const { survivors } = classifyListing({ messages, prevCursor: 0, allowedSenders: [...ALLOW, OWN], ownEmail: OWN, margin: 1 });
  assert.deepEqual(survivors, [{ id: "g", threadId: "th-g" }]); // drop any one branch and s/f/p/o leaks in
});

test("classifyListing holds the cursor one margin below the OLDEST survivor", () => {
  const messages = [lmsg("g1", 50, "alice@x.com"), lmsg("g2", 70, "alice@x.com")];
  const { survivors, nextCursor } = classifyListing({ messages, prevCursor: 0, allowedSenders: ALLOW, ownEmail: OWN, margin: 1 });
  assert.deepEqual(survivors.map((s) => s.id), ["g1", "g2"]);
  assert.equal(nextCursor, 49); // oldest survivor (50) - margin (1)
  assert.ok(nextCursor < 50, "a strictly-exclusive after=cursor must still re-include the oldest survivor");
});

test("classifyListing with no survivors advances to (max-listed - margin); off-allowlist can't pin it", () => {
  const messages = [lmsg("o", 10, "mallory@evil.com"), lmsg("p", 20, "alice@x.com", [PROCESSED_LABEL])];
  const { survivors, nextCursor } = classifyListing({ messages, prevCursor: 0, allowedSenders: ALLOW, ownEmail: OWN, margin: 1 });
  assert.deepEqual(survivors, []);
  assert.equal(nextCursor, 19); // max listed (20) - margin (1); the excluded mail falls behind it
});

test("classifyListing leaves the cursor UNCHANGED on an empty listing (no Math.max([]) -> -Infinity)", () => {
  const { survivors, nextCursor } = classifyListing({ messages: [], prevCursor: 123, allowedSenders: ALLOW, ownEmail: OWN, margin: 1 });
  assert.deepEqual(survivors, []);
  assert.equal(nextCursor, 123);
});

test("classifyListing steady-state idle (non-empty, zero survivors) is a cursor fixed point", () => {
  const messages = [lmsg("old", 100, "alice@x.com", [PROCESSED_LABEL])]; // all excluded, no new mail
  const a = classifyListing({ messages, prevCursor: 50, allowedSenders: ALLOW, ownEmail: OWN, margin: 1 });
  const b = classifyListing({ messages, prevCursor: a.nextCursor, allowedSenders: ALLOW, ownEmail: OWN, margin: 1 });
  assert.equal(a.nextCursor, 99);
  assert.equal(b.nextCursor, 99); // stable across repeated polls
});

test("deferral is not a drop: a survivor unhandled behind an earlier one is re-listed next cycle (exclusive `after`)", () => {
  // Cycle 1: two survivors; poll handles only the newer (send/per-cycle cap) and defers the older.
  const c1 = classifyListing({
    messages: [lmsg("s1", 100, "alice@x.com"), lmsg("s2", 200, "alice@x.com")],
    prevCursor: 0, allowedSenders: ALLOW, ownEmail: OWN, margin: 1,
  });
  assert.deepEqual(c1.survivors.map((s) => s.id), ["s1", "s2"]);
  assert.ok(c1.nextCursor < 100, "cursor held below the oldest (deferred) survivor");

  // Cycle 2: s2 now carries agent-processed; a strictly-exclusive list(after=c1.nextCursor) still returns s1.
  const c2 = classifyListing({
    messages: [lmsg("s1", 100, "alice@x.com"), lmsg("s2", 200, "alice@x.com", [PROCESSED_LABEL])],
    prevCursor: c1.nextCursor, allowedSenders: ALLOW, ownEmail: OWN, margin: 1,
  });
  assert.deepEqual(c2.survivors.map((s) => s.id), ["s1"], "the deferred survivor survives to the next cycle");
});

// ---- automated-mail detection (Auto-Submitted / Precedence), case-insensitive ----

test("detectAutomated flags Auto-Submitted != no and bulk/list/junk Precedence, case-insensitively", () => {
  assert.equal(detectAutomated({ "Auto-Submitted": "auto-replied" }), true);
  // Lowercase NAME + a triggering value: only a case-INSENSITIVE lookup passes this
  // (a case-sensitive impl misses the header and wrongly returns false). Header names
  // are case-insensitive on the wire and many parsers lowercase them.
  assert.equal(detectAutomated({ "auto-submitted": "auto-replied" }), true);
  assert.equal(detectAutomated({ "auto-submitted": "no" }), false); // "no" is a human send
  assert.equal(detectAutomated({ "Auto-Submitted": "No" }), false); // VALUE folded on the human side (RFC 3834's not-automated value)
  assert.equal(detectAutomated({ Precedence: "bulk" }), true);
  assert.equal(detectAutomated({ precedence: "BULK" }), true); // lowercase name + uppercase value -> both sides folded
  assert.equal(detectAutomated({ Precedence: "list" }), true);
  assert.equal(detectAutomated({}), false);
});

// ---- get-thread: trigger selection, gates, and per-message redaction ----

test("buildThreadOutput picks the newest CANDIDATE (not a newer non-candidate), and stamps receivedAt", () => {
  const messages = [
    fmsg("A", 10, "alice@x.com", "first"),
    fmsg("B", 30, "alice@x.com", "second"),               // newest candidate
    fmsg("C", 50, OWN, "own later reply", { labels: [SENT_LABEL] }), // newer, NOT a candidate
  ];
  const out = buildThreadOutput({ messages, candidateIds: ["A", "B"], allowedSenders: ALLOW, ownEmail: OWN });
  assert.equal(out.id, "B"); // never C, despite C being chronologically newer
  assert.equal(out.threadId, "T");
  assert.equal(out.isAllowedSender, true);
  assert.equal(out.receivedAt, new Date(30).toISOString());
  assert.equal(count(out.body, TRIGGER_MARKER), 1); // exactly one message marked as the trigger
});

test("buildThreadOutput.isAllowedSender uses the exact parsed address (display-name spoof fails)", () => {
  const messages = [fmsg("A", 10, '"alice@x.com" <attacker@evil.com>', "hi")];
  const out = buildThreadOutput({ messages, candidateIds: ["A"], allowedSenders: ALLOW, ownEmail: OWN });
  assert.equal(out.isAllowedSender, false); // the trailing addr-spec is attacker@evil.com
});

test("buildThreadOutput.isAutomated comes from the trigger message headers", () => {
  const messages = [fmsg("A", 10, "alice@x.com", "hi", { headers: { "Auto-Submitted": "auto-generated" } })];
  const out = buildThreadOutput({ messages, candidateIds: ["A"], allowedSenders: ALLOW, ownEmail: OWN });
  assert.equal(out.isAutomated, true);
});

test("buildThreadOutput redacts off-allowlist participants, exempts own (labeled) replies, redacts a spoofed own address", () => {
  const secret = "COMPROMISE-instructions";
  const messages = [
    fmsg("A", 10, "alice@x.com", "please help"),                          // allowed trigger -> shown
    fmsg("X", 20, "mallory@evil.com", secret),                           // off-allowlist participant -> redacted
    fmsg("O", 30, OWN, "my prior reply", { labels: [SENT_LABEL] }),      // own (unforgeable label) -> exempt
    fmsg("S", 40, OWN, "SPOOFED-body", { labels: [] }),                  // spoofs the own address, no sent label -> redacted
  ];
  const out = buildThreadOutput({ messages, candidateIds: ["A"], allowedSenders: ALLOW, ownEmail: OWN });
  assert.match(out.body, /please help/);
  assert.doesNotMatch(out.body, /COMPROMISE-instructions/);
  assert.match(out.body, /my prior reply/);
  assert.doesNotMatch(out.body, /SPOOFED-body/); // From alone never grants the own-exemption
});

test("buildThreadOutput never trusts the own address via the allowlist -- only the baxter-sent label", () => {
  // Self-impersonation guard (review 2095484 F1): even with OWN on the allowlist, a
  // forged From:<own> WITHOUT the sent label must be redacted -- allowlist membership
  // must never exempt the own address; only the unforgeable label does.
  const messages = [
    fmsg("A", 10, "alice@x.com", "please help"),            // trigger, allowed
    fmsg("Z", 20, OWN, "FORGED-as-baxter", { labels: [] }), // own address, no sent label
  ];
  const out = buildThreadOutput({ messages, candidateIds: ["A"], allowedSenders: [...ALLOW, OWN], ownEmail: OWN });
  assert.doesNotMatch(out.body, /FORGED-as-baxter/);
});

// ---- sending: label, operator-only recipient, and record-before-send ordering ----

test("buildSendArgs / buildReplyArgs attach the baxter-sent label and pass the body through", () => {
  assert.deepEqual(buildSendArgs({ to: "op@x.com", subject: "S", body: "B" }), { to: "op@x.com", subject: "S", text: "B", labels: [SENT_LABEL] });
  assert.deepEqual(buildReplyArgs({ body: "B" }), { text: "B", labels: [SENT_LABEL] });
});

test("operatorRecipient returns OPERATOR_EMAIL and throws when unset (send takes no recipient arg)", () => {
  assert.equal(operatorRecipient({ OPERATOR_EMAIL: "op@x.com" }), "op@x.com");
  assert.throws(() => operatorRecipient({}), /OPERATOR_EMAIL/);
});

test("performSend records before the network call AND targets OPERATOR_EMAIL itself (no recipient arg surface)", async () => {
  const order = [];
  let sentInbox, sentArgs;
  const client = { inboxes: { messages: {
    send: async (inboxId, args) => { order.push("send"); sentInbox = inboxId; sentArgs = args; return { messageId: "m1", threadId: "t1" }; },
  } } };
  const recordSend = async () => { order.push("record"); };
  // performSend takes `env`, NOT a free-form `to`: it resolves operatorRecipient(env)
  // itself, so the operator-only property is enforced here, not deferred to CLI dispatch
  // where a prompt-injected argv recipient could otherwise slip through.
  await performSend({ client, inboxId: "inb", env: { OPERATOR_EMAIL: "op@x.com" }, subject: "S", body: "B", recordSend });
  assert.deepEqual(order, ["record", "send"]); // over-counting a flood guard is the safe direction
  assert.equal(sentInbox, "inb");
  assert.deepEqual(sentArgs, { to: "op@x.com", subject: "S", text: "B", labels: [SENT_LABEL] }); // recipient came from env, not an arg

  // ...via operatorRecipient's fail-loud path: an unset OPERATOR_EMAIL must REJECT
  // (keep performSend async so this is a rejection, not a sync throw assert.rejects
  // would skip), and it must resolve the recipient BEFORE recordSend -- so a config
  // error neither records (burns a cap slot) nor reaches the network.
  await assert.rejects(() => performSend({ client, inboxId: "inb", env: {}, subject: "S", body: "B", recordSend }), /OPERATOR_EMAIL/);
  assert.deepEqual(order, ["record", "send"], "the rejected config-error send added neither a record nor a send");
});

test("performReply records before replying and lets AgentMail own the threading", async () => {
  const order = [];
  let gotInbox, gotMsg, gotArgs;
  const client = { inboxes: { messages: {
    reply: async (inboxId, messageId, args) => { order.push("reply"); gotInbox = inboxId; gotMsg = messageId; gotArgs = args; return { messageId: "m2", threadId: "t1" }; },
  } } };
  const recordSend = async () => { order.push("record"); };
  await performReply({ client, inboxId: "inb", messageId: "orig", body: "B", recordSend });
  assert.deepEqual(order, ["record", "reply"]);
  assert.equal(gotInbox, "inb");
  assert.equal(gotMsg, "orig"); // reply targets the original message; no hand-built In-Reply-To/References
  assert.deepEqual(gotArgs, { text: "B", labels: [SENT_LABEL] });
});
