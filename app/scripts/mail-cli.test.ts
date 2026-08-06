// TDD tests for mail-cli.ts, the Resend-backed outbound mail CLI (mail.ts's
// AgentMail replacement). Unit-level: inject a fake resend/adapter + fake
// guards, no network, no real Resend/Chat SDK objects. The point of this file
// is the security invariants -- `from` is never a parameter anywhere, and
// EVERY send verb re-validates its recipient against the allowlist
// immediately before dispatch (reply via a single threadEntry() snapshot,
// cross-checked against the threadId's own embedded address, not the
// model-supplied threadId alone) -- plus the Resend SDK's {data,error}
// envelope (it never throws on a failed send/lookup) being handled on every
// raw-SDK call site. All three send verbs (send/reply/send-calendar) go
// through the raw Resend SDK, not the Chat SDK's thread.post() -- that path
// can't carry a real subject/threading headers/attachments (see mail-cli.ts's
// header).
//
// BAXTER_EMAIL/MAIL_FROM_NAME are read once at mail-cli.ts's module scope (the
// from-lock), so they must be set BEFORE the module is evaluated -- a dynamic
// import after setting them, mirroring mail-transcript.test.ts's
// MAIL_TRANSCRIPT_DIR_OVERRIDE pattern (a static top-of-file import would load
// before this file's own statements run, per ES module semantics).
import { test } from "node:test";
import assert from "node:assert/strict";

const OWN = "baxter@bax.bot";
process.env.BAXTER_EMAIL = OWN;
process.env.MAIL_FROM_NAME = "Baxter";
const { sendNew, sendReply, sendCalendar, getAttachment } = await import("./mail-cli.ts");

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
// sendReply (raw Resend SDK path -- the Chat SDK adapter's in-memory
// ThreadResolver has no history in a fresh CLI process, see mail-cli.ts).
// The correspondent/subject/last-inbound-message-id all come from a SINGLE
// threadEntry() snapshot, not three separate lookups.
// ---------------------------------------------------------------------------

const THREAD_ID = "resend:friend@example.com:abcd1234";

test("reply refuses an unknown thread (no indexed entry)", async () => {
  const sent: unknown[] = [];
  const fakeResend = { emails: { send: async (p: unknown) => { sent.push(p); return { data: { id: "e1" }, error: null }; } } };
  await assert.rejects(() =>
    sendReply(THREAD_ID, "body", {
      resend: () => fakeResend,
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
  const sent: unknown[] = [];
  const fakeResend = { emails: { send: async (p: unknown) => { sent.push(p); return { data: { id: "e1" }, error: null }; } } };
  let resolveCalled = false;
  // The index says the correspondent is alice, but the adapter decodes the
  // threadId's OWN embedded address as someone else entirely -- a divergence
  // that must refuse outright rather than trust the index alone.
  await assert.rejects(() =>
    sendReply(THREAD_ID, "body", {
      resend: () => fakeResend,
      adapter: { decodeThreadId: () => ({ toAddress: "mallory@evil.com" }) },
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
  const sent: unknown[] = [];
  const fakeResend = { emails: { send: async (p: unknown) => { sent.push(p); return { data: { id: "e1" }, error: null }; } } };
  // THREAD_ID embeds "friend@example.com" (the 2nd colon-separated segment) --
  // an indexed correspondent that DISAGREES with that must still be refused,
  // even with no adapter/decodeThreadId at all (adapter omitted entirely).
  await assert.rejects(() =>
    sendReply(THREAD_ID, "body", {
      resend: () => fakeResend,
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
  const sent: unknown[] = [];
  const fakeResend = { emails: { send: async (p: unknown) => { sent.push(p); return { data: { id: "e1" }, error: null }; } } };
  await assert.rejects(() =>
    sendReply(THREAD_ID, "body", {
      resend: () => fakeResend,
      adapter: { decodeThreadId: () => ({ toAddress: "friend@example.com" }) },
      threadEntry: () => ({ from: "friend@example.com" }),
      resolveRecipient: () => { throw new Error("recipient not allowed"); },
      gateOutbound: async () => {},
      assertUnderSendCap: async () => {},
      append: async () => {},
    }),
  );
  assert.equal(sent.length, 0);
});

test("reply sends via the raw Resend SDK with from hard-set, In-Reply-To/References, and a Re:-prefixed subject", async () => {
  const sent: Record<string, unknown>[] = [];
  const fakeResend = { emails: { send: async (p: Record<string, unknown>) => { sent.push(p); return { data: { id: "e1" }, error: null }; } } };
  let appendedTo: string | undefined;
  await sendReply(THREAD_ID, "body text", {
    resend: () => fakeResend,
    adapter: { decodeThreadId: () => ({ toAddress: "friend@example.com" }) },
    threadEntry: () => ({ from: "friend@example.com", subject: "Original subject", messageId: "<inbound-1@example.com>" }),
    resolveRecipient: (x: string) => x,
    gateOutbound: async () => {},
    assertUnderSendCap: async () => {},
    append: async (to: string) => { appendedTo = to; },
  });
  assert.equal(sent.length, 1);
  const payload = sent[0];
  assert.equal(payload.from, `Baxter <${OWN}>`); // hard-set -- never a caller argument
  assert.equal(payload.to, "friend@example.com");
  assert.equal(payload.subject, "Re: Original subject");
  assert.deepEqual(payload.headers, { "In-Reply-To": "<inbound-1@example.com>", References: "<inbound-1@example.com>" });
  assert.equal(appendedTo, "friend@example.com");
});

test("reply doesn't double-prefix a subject that's already 'Re: ...', and omits headers with no last-inbound id", async () => {
  const sent: Record<string, unknown>[] = [];
  const fakeResend = { emails: { send: async (p: Record<string, unknown>) => { sent.push(p); return { data: { id: "e1" }, error: null }; } } };
  await sendReply(THREAD_ID, "body", {
    resend: () => fakeResend,
    adapter: { decodeThreadId: () => ({ toAddress: "friend@example.com" }) },
    threadEntry: () => ({ from: "friend@example.com", subject: "Re: Original subject" }), // no messageId
    resolveRecipient: (x: string) => x,
    gateOutbound: async () => {},
    assertUnderSendCap: async () => {},
    append: async () => {},
  });
  assert.equal(sent[0].subject, "Re: Original subject");
  assert.equal(Object.prototype.hasOwnProperty.call(sent[0], "headers"), false); // no last-inbound id -> no threading headers
});

test("reply surfaces a Resend send failure ({data:null,error}) instead of reporting success", async () => {
  const fakeResend = { emails: { send: async () => ({ data: null, error: { message: "boom" } }) } };
  let appended = false;
  await assert.rejects(
    () =>
      sendReply(THREAD_ID, "body", {
        resend: () => fakeResend,
        adapter: { decodeThreadId: () => ({ toAddress: "friend@example.com" }) },
        threadEntry: () => ({ from: "friend@example.com" }),
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
