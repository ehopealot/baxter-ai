// TDD tests for mail-cli.ts, the Resend-backed outbound mail CLI. Unit-level:
// inject a fake resend/adapter/chat + fake guards, no network, no real
// Resend/Chat SDK objects. The point of this file
// is the security invariants -- `from` is never a parameter anywhere, and
// EVERY send verb re-validates its recipient against the allowlist
// immediately before dispatch (reply via a single threadEntry() snapshot,
// cross-checked against the threadId's own embedded address, not the
// model-supplied threadId alone) -- plus the Resend SDK's {data,error}
// envelope (it never throws on a failed send/lookup) being handled on every
// raw-SDK call site. sendNew/sendCalendar/getAttachment go through the raw
// Resend SDK; sendReply goes through the Chat SDK's thread.post(), seeded from
// a fake adapter.threadResolver that mirrors the REAL installed
// @resend/chat-sdk-adapter@0.2.2's postMessage() subject/headers formula (see
// fakeChatSdk below) -- so these tests exercise both "did mail-cli.ts seed the
// resolver correctly" and "what would actually go out on the wire".
//
// BAXTER_EMAIL/MAIL_FROM_NAME are read once at mail-cli.ts's module scope (the
// from-lock), so they must be set BEFORE the module is evaluated -- a dynamic
// import after setting them, mirroring mail-transcript.test.ts's
// MAIL_TRANSCRIPT_DIR_OVERRIDE pattern (a static top-of-file import would load
// before this file's own statements run, per ES module semantics).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const OWN = "baxter@bax.bot";
process.env.BAXTER_EMAIL = OWN;
process.env.MAIL_FROM_NAME = "Baxter";
// T4 (usage-metrics): the mail_tx hooks (sendRaw's provider-accept tail + sendReply
// after thread.post) record into USAGE_DIR_OVERRIDE. The signal store reads the
// override at CALL time (not module-evaluation time), so the assignment order isn't
// load-bearing for the store itself -- but setting it before the dynamic import keeps
// every record in this process off the real state dir (same convention as
// sms-cli.test.ts).
const MAIL_CLI_USAGE = mkdtempSync(join(tmpdir(), "mail-cli-usage-"));
process.env.USAGE_DIR_OVERRIDE = MAIL_CLI_USAGE;
const { sendNew, sendReply, sendCalendar, getAttachment } = await import("./mail-cli.ts");

function spawnSkip(...args: string[]) {
  const env = { ...process.env };
  delete env.BAXTER_EMAIL;
  delete env.RESEND_API_KEY;
  return spawnSync(process.execPath, [fileURLToPath(new URL("./mail-cli.ts", import.meta.url)), "skip", ...args], {
    env,
    input: "",
    encoding: "utf8",
  });
}

test("skip exits successfully without mail credentials", () => {
  const result = spawnSkip();
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), JSON.stringify({ skipped: true }));
});

test("skip logs a supplied reason", () => {
  const result = spawnSkip("nothing actionable");
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), JSON.stringify({ skipped: true }));
  assert.match(result.stderr, /reason=nothing actionable/);
});

test("skip joins multiple positional reason words", () => {
  const result = spawnSkip("nothing", "actionable");
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), JSON.stringify({ skipped: true }));
  assert.match(result.stderr, /reason=nothing actionable/);
});

// Mirrors ThreadResolver.trackMessage/trackSubject/getReplyHeaders/getSubject
// (thread-resolver.js) closely enough to exercise mail-cli.ts's seeding calls
// and reproduce what the real adapter would actually send.
function fakeThreadResolver() {
  const messages = new Map<string, string[]>();
  const subjects = new Map<string, string>();
  return {
    trackMessage(threadId: string, messageId: string) {
      const arr = messages.get(threadId) ?? [];
      if (!arr.includes(messageId)) arr.push(messageId);
      messages.set(threadId, arr);
    },
    trackSubject(threadId: string, subject: string) {
      if (!subjects.has(threadId)) subjects.set(threadId, subject); // set-once, like the real one
    },
    getReplyHeaders(threadId: string): { "In-Reply-To": string; References: string } | undefined {
      const arr = messages.get(threadId);
      if (!arr || arr.length === 0) return undefined;
      return { "In-Reply-To": arr[arr.length - 1], References: arr.join(" ") };
    },
    getSubject(threadId: string): string | undefined {
      return subjects.get(threadId);
    },
  };
}

// A fake { adapter, chat } pair whose chat.thread(threadId).post(body) reads
// from the SAME threadResolver mail-cli.ts seeds, and reproduces postMessage's
// own (verified) subject formula: `storedSubject ? "Re: <subject>" : "New
// message"`, with headers only when a message chain was tracked. `sent`
// accumulates what was actually "sent" for assertions.
function fakeChatSdk(decodeThreadId?: (threadId: string) => { toAddress: string }) {
  const threadResolver = fakeThreadResolver();
  const sent: Array<{ threadId: string; body: string; subject: string; headers?: { "In-Reply-To": string; References: string } }> = [];
  const adapter = { decodeThreadId, threadResolver };
  const chat = {
    thread: async (threadId: string) => ({
      post: async (body: string) => {
        const headers = threadResolver.getReplyHeaders(threadId);
        const storedSubject = threadResolver.getSubject(threadId);
        const subject = storedSubject ? `Re: ${storedSubject}` : "New message";
        sent.push({ threadId, body, subject, ...(headers ? { headers } : {}) });
        return { id: "sent-id" };
      },
    }),
  };
  return { adapter, chat, sent };
}

// ---------------------------------------------------------------------------
// sendNew (raw Resend SDK path)
// ---------------------------------------------------------------------------

test("send uses the configured from, the real subject, and refuses a disallowed recipient", async () => {
  const sent: Record<string, unknown>[] = [];
  const fakeResend = { emails: { send: async (p: Record<string, unknown>) => { sent.push(p); return { data: { id: "e1" }, error: null }; } } };

  // disallowed recipient -> throws, nothing sent
  await assert.rejects(() =>
    sendNew("blocked@evil.com", "s", "body", {
      resend: () => fakeResend,
      resolveRecipient: () => { throw new Error("recipient not allowed"); },
      gateOutbound: async () => {},
      assertUnderSendCap: async () => {},
      append: async () => {},
    }),
  );
  assert.equal(sent.length, 0);

  // allowed -> one send, from hard-set, the REAL subject on the wire (not
  // "New message" -- the Chat SDK adapter's in-memory ThreadResolver, which a
  // fresh CLI process never has history for, is not involved at all)
  await sendNew("ok@example.com", "Dinner plans", "body", {
    resend: () => fakeResend,
    resolveRecipient: (x: string) => x,
    gateOutbound: async () => {},
    assertUnderSendCap: async () => {},
    append: async () => {},
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "ok@example.com");
  assert.equal(sent[0].from, `Baxter <${OWN}>`); // hard-set -- never a caller argument
  assert.equal(sent[0].subject, "Dinner plans");
  assert.equal(sent[0].text, "body");
  assert.equal(Object.prototype.hasOwnProperty.call(sent[0], "headers"), false); // fresh thread -- no threading headers
});

test("send runs the guards in order: recipient -> moderation -> send-cap -> post -> append", async () => {
  const order: string[] = [];
  const fakeResend = { emails: { send: async () => { order.push("post"); return { data: { id: "e1" }, error: null }; } } };
  await sendNew("ok@example.com", "s", "body", {
    resend: () => fakeResend,
    resolveRecipient: (x: string) => { order.push("recipient"); return x; },
    gateOutbound: async () => { order.push("moderation"); },
    assertUnderSendCap: async () => { order.push("cap"); },
    append: async () => { order.push("append"); },
  });
  assert.deepEqual(order, ["recipient", "moderation", "cap", "post", "append"]);
});

test("send surfaces a Resend send failure ({data:null,error}) instead of reporting success", async () => {
  const fakeResend = { emails: { send: async () => ({ data: null, error: { message: "rate limited" } }) } };
  let appended = false;
  await assert.rejects(
    () =>
      sendNew("ok@example.com", "s", "body", {
        resend: () => fakeResend,
        resolveRecipient: (x: string) => x,
        gateOutbound: async () => {},
        assertUnderSendCap: async () => {},
        append: async () => { appended = true; },
      }),
    /rate limited/,
  );
  assert.equal(appended, false);
});

test("no from parameter is accepted anywhere in the CLI arg surface", async () => {
  // sendNew/sendReply/sendCalendar signatures take (to|threadId, subject?, body,
  // icsPath?, deps) -- assert no 'from' arg leaks into any of them.
  assert.equal(sendNew.length <= 4, true);
  assert.equal(sendReply.length <= 3, true);
  assert.equal(sendCalendar.length <= 5, true);
});

// ---------------------------------------------------------------------------
// sendReply (Chat SDK path, resolver seeded from the transcript -- see
// mail-cli.ts's header/sendReply comment). The correspondent+subject come
// from a single threadEntry() snapshot; the inbound Message-ID chain comes
// from one readMailTranscript() read, filtered to this thread's inbound
// entries.
// ---------------------------------------------------------------------------

const THREAD_ID = "resend:friend@example.com:abcd1234";

test("reply refuses an unknown thread (no indexed entry)", async () => {
  const { adapter, chat, sent } = fakeChatSdk();
  await assert.rejects(() =>
    sendReply(THREAD_ID, "body", {
      adapter,
      chat,
      threadEntry: () => null,
      resolveRecipient: (x: string) => x,
      gateOutbound: async () => {},
      assertUnderSendCap: async () => {},
      append: async () => {},
    }),
  );
  assert.equal(sent.length, 0);
});

test("reply refuses when the threadId's embedded address doesn't match the indexed correspondent", async () => {
  // The index says the correspondent is alice, but the adapter decodes the
  // threadId's OWN embedded address as someone else entirely -- a divergence
  // that must refuse outright rather than trust the index alone.
  const { adapter, chat, sent } = fakeChatSdk(() => ({ toAddress: "mallory@evil.com" }));
  let resolveCalled = false;
  await assert.rejects(() =>
    sendReply(THREAD_ID, "body", {
      adapter,
      chat,
      threadEntry: () => ({ from: "alice@example.com" }),
      resolveRecipient: (x: string) => { resolveCalled = true; return x; },
      gateOutbound: async () => {},
      assertUnderSendCap: async () => {},
      append: async () => {},
    }),
  );
  assert.equal(sent.length, 0);
  assert.equal(resolveCalled, false); // refused before even reaching the allowlist check
});

test("reply falls back to parsing the threadId string when the adapter has no decodeThreadId, and still cross-checks it", async () => {
  // THREAD_ID embeds "friend@example.com" (the 2nd colon-separated segment) --
  // an indexed correspondent that DISAGREES with that must still be refused,
  // even with no adapter.decodeThreadId at all.
  const { adapter, chat, sent } = fakeChatSdk(); // no decodeThreadId
  await assert.rejects(() =>
    sendReply(THREAD_ID, "body", {
      adapter,
      chat,
      threadEntry: () => ({ from: "someone-else@example.com" }),
      resolveRecipient: (x: string) => x,
      gateOutbound: async () => {},
      assertUnderSendCap: async () => {},
      append: async () => {},
    }),
  );
  assert.equal(sent.length, 0);
});

test("reply refuses a since-disallowed correspondent even when the embedded address matches", async () => {
  const { adapter, chat, sent } = fakeChatSdk(() => ({ toAddress: "friend@example.com" }));
  await assert.rejects(() =>
    sendReply(THREAD_ID, "body", {
      adapter,
      chat,
      threadEntry: () => ({ from: "friend@example.com" }),
      resolveRecipient: () => { throw new Error("recipient not allowed"); },
      gateOutbound: async () => {},
      assertUnderSendCap: async () => {},
      append: async () => {},
    }),
  );
  assert.equal(sent.length, 0);
});

test("reply sends via the Chat SDK with the FULL In-Reply-To/References chain and a Re:-prefixed subject", async () => {
  const { adapter, chat, sent } = fakeChatSdk(() => ({ toAddress: "friend@example.com" }));
  let appendedTo: string | undefined;
  let appendedSubject: string | undefined;
  await sendReply(THREAD_ID, "body text", {
    adapter,
    chat,
    threadEntry: () => ({ from: "friend@example.com", subject: "Original subject" }),
    readMailTranscript: () => [
      { direction: "in", at: "t0", subject: "Original subject", content: "hi", threadId: THREAD_ID, messageId: "<m1@example.com>" },
      { direction: "out", at: "t1", subject: "Re: Original subject", content: "an earlier reply" }, // outbound -- excluded from the chain
      { direction: "in", at: "t2", subject: "Original subject", content: "follow-up", threadId: THREAD_ID, messageId: "<m2@example.com>" },
      { direction: "in", at: "t3", subject: "Original subject", content: "different thread", threadId: "resend:friend@example.com:other", messageId: "<m3@example.com>" }, // different thread -- excluded
    ],
    resolveRecipient: (x: string) => x,
    gateOutbound: async () => {},
    assertUnderSendCap: async () => {},
    append: async (to: string, entry: { subject: string }) => { appendedTo = to; appendedSubject = entry.subject; },
  });
  assert.equal(sent.length, 1);
  const posted = sent[0];
  assert.equal(posted.body, "body text");
  assert.equal(posted.subject, "Re: Original subject"); // from the adapter's own (verified) formula, not double-prefixed by mail-cli.ts
  // In-Reply-To = the LAST tracked id; References = the FULL chain in order (both inbound entries, oldest first) -- not just the latest.
  assert.deepEqual(posted.headers, { "In-Reply-To": "<m2@example.com>", References: "<m1@example.com> <m2@example.com>" });
  assert.equal(appendedTo, "friend@example.com");
  assert.equal(appendedSubject, "Re: Original subject"); // the transcript records what was actually sent
});

test("reply doesn't double-prefix a subject that's already 'Re: ...', and omits headers with no tracked inbound ids", async () => {
  const { adapter, chat, sent } = fakeChatSdk(() => ({ toAddress: "friend@example.com" }));
  await sendReply(THREAD_ID, "body", {
    adapter,
    chat,
    threadEntry: () => ({ from: "friend@example.com", subject: "Re: Original subject" }),
    readMailTranscript: () => [], // no matching inbound entries -> no threading headers
    resolveRecipient: (x: string) => x,
    gateOutbound: async () => {},
    assertUnderSendCap: async () => {},
    append: async () => {},
  });
  assert.equal(sent[0].subject, "Re: Original subject"); // not "Re: Re: Original subject"
  assert.equal(Object.prototype.hasOwnProperty.call(sent[0], "headers"), false);
});

test("reply surfaces a Resend send failure (the adapter throws on it) instead of reporting success", async () => {
  const { adapter, chat } = fakeChatSdk(() => ({ toAddress: "friend@example.com" }));
  // Mirrors postMessage()'s own behavior on a failed send: it throws, rather
  // than returning a value -- verified against adapter.js's `if
  // (response.error || !response.data) { throw new Error(...) }`.
  chat.thread = async () => ({ post: async () => { throw new Error("Failed to send email: boom"); } });
  let appended = false;
  await assert.rejects(
    () =>
      sendReply(THREAD_ID, "body", {
        adapter,
        chat,
        threadEntry: () => ({ from: "friend@example.com" }),
        readMailTranscript: () => [],
        resolveRecipient: (x: string) => x,
        gateOutbound: async () => {},
        assertUnderSendCap: async () => {},
        append: async () => { appended = true; },
      }),
    /boom/,
  );
  assert.equal(appended, false);
});

// ---------------------------------------------------------------------------
// sendCalendar (raw Resend SDK path)
// ---------------------------------------------------------------------------

test("sendCalendar sends via the raw Resend SDK with from hard-set to OWN_EMAIL and the .ics attached", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mail-cli-ics-"));
  const icsPath = join(dir, "invite.ics");
  writeFileSync(icsPath, "BEGIN:VCALENDAR\nEND:VCALENDAR\n");

  const sent: Record<string, unknown>[] = [];
  const fakeResend = { emails: { send: async (payload: Record<string, unknown>) => { sent.push(payload); return { data: { id: "email_1" }, error: null }; } } };

  // disallowed recipient -> throws, nothing sent
  await assert.rejects(() =>
    sendCalendar("blocked@evil.com", "Invite", "body", icsPath, {
      resend: () => fakeResend,
      resolveRecipient: () => { throw new Error("recipient not allowed"); },
      gateOutbound: async () => {},
      assertUnderSendCap: async () => {},
      append: async () => {},
    }),
  );
  assert.equal(sent.length, 0);

  await sendCalendar("ok@example.com", "Invite", "body", icsPath, {
    resend: () => fakeResend,
    resolveRecipient: (x: string) => x,
    gateOutbound: async () => {},
    assertUnderSendCap: async () => {},
    append: async () => {},
  });
  assert.equal(sent.length, 1);
  const payload = sent[0];
  assert.equal(payload.to, "ok@example.com");
  assert.equal(payload.from, `Baxter <${OWN}>`); // hard-set from buildup, never a caller argument
  const attachments = payload.attachments as Array<{ filename: string; content: Buffer }>;
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].filename, "invite.ics");
  assert.ok(attachments[0].content.toString("utf8").includes("BEGIN:VCALENDAR"));
});

test("sendCalendar surfaces a Resend send failure ({data:null,error}) instead of reporting success", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mail-cli-ics-fail-"));
  const icsPath = join(dir, "invite.ics");
  writeFileSync(icsPath, "BEGIN:VCALENDAR\nEND:VCALENDAR\n");

  const fakeResend = { emails: { send: async () => ({ data: null, error: { message: "quota exceeded" } }) } };
  let appended = false;
  await assert.rejects(
    () =>
      sendCalendar("ok@example.com", "Invite", "body", icsPath, {
        resend: () => fakeResend,
        resolveRecipient: (x: string) => x,
        gateOutbound: async () => {},
        assertUnderSendCap: async () => {},
        append: async () => { appended = true; },
      }),
    /quota exceeded/,
  );
  assert.equal(appended, false);
});

// ---------------------------------------------------------------------------
// getAttachment (raw Resend SDK path)
// ---------------------------------------------------------------------------

test("getAttachment mints a download URL for an inbound attachment found by filename", async () => {
  const fakeResend = {
    emails: {
      receiving: {
        get: async (id: string) => ({
          data: { id, attachments: [{ id: "att_1", filename: "photo.jpg" }, { id: "att_2", filename: "notes.txt" }] },
          error: null,
        }),
        attachments: {
          get: async (opts: { emailId: string; id: string }) => ({
            data: { id: opts.id, download_url: `https://example.com/${opts.id}`, expires_at: "2026-08-06T01:00:00Z" },
            error: null,
          }),
        },
      },
    },
  };
  const out = await getAttachment("email_1", "photo.jpg", { resend: () => fakeResend });
  const parsed = JSON.parse(out);
  assert.equal(parsed.id, "att_1");
  assert.match(parsed.download_url, /att_1$/);
});

test("getAttachment throws when no attachment matches the filename", async () => {
  const fakeResend = {
    emails: {
      receiving: {
        get: async () => ({ data: { attachments: [{ id: "att_1", filename: "photo.jpg" }] }, error: null }),
        attachments: { get: async () => ({ data: {}, error: null }) },
      },
    },
  };
  await assert.rejects(() => getAttachment("email_1", "missing.pdf", { resend: () => fakeResend }));
});

test("getAttachment throws (not prints success) when the email lookup returns an error envelope", async () => {
  const fakeResend = {
    emails: {
      receiving: {
        get: async () => ({ data: null, error: { message: "not found" } }),
        attachments: { get: async () => ({ data: {}, error: null }) },
      },
    },
  };
  await assert.rejects(() => getAttachment("email_1", "photo.jpg", { resend: () => fakeResend }), /not found/);
});

test("getAttachment throws (not prints success) when minting the download URL returns an error envelope", async () => {
  const fakeResend = {
    emails: {
      receiving: {
        get: async () => ({ data: { attachments: [{ id: "att_1", filename: "photo.jpg" }] }, error: null }),
        attachments: { get: async () => ({ data: null, error: { message: "expired" } }) },
      },
    },
  };
  await assert.rejects(() => getAttachment("email_1", "photo.jpg", { resend: () => fakeResend }), /expired/);
});

// ---------------------------------------------------------------------------
// T4 (usage-metrics): mail_tx signals. TWO hook sites, both metering EXACTLY
// ONCE per success path and ZERO on every refusal/failure -- sendRaw (the
// shared tail of sendNew AND sendCalendar) records right after the provider's
// {data,error} accept check; sendReply (which bypasses sendRaw via the Chat
// SDK's thread.post()) records right after a successful post, using the
// CANONICAL resolveRecipient return captured at the authorize step (whose
// allowlist spelling may carry case). The counterpart label is canonicalMail()
// -- the ONE definition in transcript.ts -- so mail_rx and mail_tx for the
// same person collapse onto one label series.
// ---------------------------------------------------------------------------

type TxRow = { v?: number; t: number; kind: string; counterpart?: string };

function readTxRows(dir: string): TxRow[] {
  try {
    return readFileSync(join(dir, "signals.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as TxRow);
  } catch {
    return []; // no signals.jsonl -> nothing was recorded
  }
}

function freshUsage(): string {
  const d = mkdtempSync(join(tmpdir(), "mail-tx-usage-"));
  process.env.USAGE_DIR_OVERRIDE = d;
  return d;
}

const endUsage = (dir: string) => {
  process.env.USAGE_DIR_OVERRIDE = MAIL_CLI_USAGE;
  rmSync(dir, { recursive: true, force: true });
};

const okResend = () => ({ emails: { send: async () => ({ data: { id: "e1" }, error: null }) } });

const okGuards = {
  resolveRecipient: (x: string) => x,
  gateOutbound: async () => {},
  assertUnderSendCap: async () => {},
  append: async () => {},
};

test("mail_tx: sendNew success records ONE signal with the canonicalized (lowercased) resolveRecipient return", async () => {
  const usage = freshUsage();
  try {
    await sendNew("friend@example.com", "s", "body", {
      ...okGuards,
      resend: () => okResend(),
      resolveRecipient: (x: string) => (x === "friend@example.com" ? "Friend@Example.COM" : x), // the allowlist's canonical spelling, mixed case
    });
    const rows = readTxRows(usage);
    assert.equal(rows.length, 1, "exactly one mail_tx per successful send");
    assert.equal(rows[0].kind, "mail_tx");
    assert.equal(rows[0].counterpart, "friend@example.com", "canonicalMail lowercases the allowlist spelling so mail_rx/mail_tx collapse");
    assert.equal(rows[0].v, 1, "store-stamped version");
    assert.equal(typeof rows[0].t, "number");
  } finally { endUsage(usage); }
});

test("mail_tx: sendNew records NOTHING on every refusal/failure path", async () => {
  const usage = freshUsage();
  try {
    // resolveRecipient throw (recipient not on the allowlist)
    await assert.rejects(
      () => sendNew("blocked@evil.com", "s", "b", { ...okGuards, resend: () => okResend(), resolveRecipient: () => { throw new Error("recipient not allowed"); } }),
      /recipient not allowed/,
    );
    // moderation gate throw
    await assert.rejects(
      () => sendNew("ok@example.com", "s", "b", { ...okGuards, resend: () => okResend(), gateOutbound: async () => { throw new Error("message not sent -- blocked"); } }),
      /blocked/,
    );
    // send-cap throw
    await assert.rejects(
      () => sendNew("ok@example.com", "s", "b", { ...okGuards, resend: () => okResend(), assertUnderSendCap: async () => { throw new Error("daily send cap reached"); } }),
      /send cap/,
    );
    // provider failure ({data:null,error} envelope -- the raw SDK never throws)
    await assert.rejects(
      () => sendNew("ok@example.com", "s", "b", { ...okGuards, resend: () => ({ emails: { send: async () => ({ data: null, error: { message: "rate limited" } }) } }) }),
      /rate limited/,
    );
    assert.equal(readTxRows(usage).length, 0, "zero mail_tx across all four refusal paths");
  } finally { endUsage(usage); }
});

test("mail_tx: sendReply success records the CANONICAL allowlist spelling even when the thread index's from casing differs", async () => {
  const usage = freshUsage();
  const { adapter, chat } = fakeChatSdk(() => ({ toAddress: "friend@example.com" }));
  try {
    await sendReply(THREAD_ID, "body", {
      adapter,
      chat,
      threadEntry: () => ({ from: "FRIEND@example.com", subject: "Original subject" }), // index casing differs...
      readMailTranscript: () => [],
      ...okGuards,
      resolveRecipient: () => "Friend@Example.COM", // ...and the allowlist's canonical spelling is mixed case
    });
    const rows = readTxRows(usage);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "mail_tx");
    assert.equal(rows[0].counterpart, "friend@example.com", "the hook canonicalizes the resolveRecipient return, not the index spelling");
    assert.equal(rows[0].v, 1);
  } finally { endUsage(usage); }
});

test("mail_tx: sendReply records NOTHING on thread-mismatch, resolveRecipient throw, and thread.post() throw", async () => {
  const usage = freshUsage();
  try {
    // thread-mismatch refusal (embedded address != indexed correspondent)
    const mismatch = fakeChatSdk(() => ({ toAddress: "mallory@evil.com" }));
    await assert.rejects(() =>
      sendReply(THREAD_ID, "b", { adapter: mismatch.adapter, chat: mismatch.chat, threadEntry: () => ({ from: "alice@example.com" }), ...okGuards }));
    // resolveRecipient throw (since-disallowed correspondent)
    const okSdk = fakeChatSdk(() => ({ toAddress: "friend@example.com" }));
    await assert.rejects(
      () => sendReply(THREAD_ID, "b", { adapter: okSdk.adapter, chat: okSdk.chat, threadEntry: () => ({ from: "friend@example.com" }), ...okGuards, resolveRecipient: () => { throw new Error("recipient not allowed"); } }),
      /recipient not allowed/,
    );
    // thread.post() throw (Resend send failure -- the adapter throws)
    const throwPost = fakeChatSdk(() => ({ toAddress: "friend@example.com" }));
    throwPost.chat.thread = async () => ({ post: async () => { throw new Error("Failed to send email: boom"); } });
    await assert.rejects(
      () => sendReply(THREAD_ID, "b", { adapter: throwPost.adapter, chat: throwPost.chat, threadEntry: () => ({ from: "friend@example.com" }), readMailTranscript: () => [], ...okGuards }),
      /boom/,
    );
    assert.equal(readTxRows(usage).length, 0, "zero mail_tx across all three refusal paths");
  } finally { endUsage(usage); }
});

test.after(() => { delete process.env.USAGE_DIR_OVERRIDE; rmSync(MAIL_CLI_USAGE, { recursive: true, force: true }); });
