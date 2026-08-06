// TDD tests for mail-cli.ts, the Resend-backed outbound mail CLI (mail.ts's
// AgentMail replacement). Unit-level: inject a fake adapter/chat + fake guards,
// no network, no real Resend/Chat SDK objects. The point of this file is the
// security invariants -- `from` is never a parameter anywhere, and EVERY send
// verb re-validates its recipient against the allowlist immediately before
// dispatch (reply via the thread index, not the model-supplied threadId).
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

test("send uses the configured from and refuses a disallowed recipient", async () => {
  const posts: unknown[] = [];
  const fakeChat = { thread: async (_threadId: string) => ({ post: async (m: unknown) => { posts.push(m); return { id: "x" }; } }) };
  const fakeAdapter = { openDM: async (to: string) => `resend:${to}:hash` };

  // disallowed recipient -> throws, no post
  await assert.rejects(() =>
    sendNew("blocked@evil.com", "s", "body", {
      adapter: fakeAdapter,
      chat: fakeChat,
      resolveRecipient: () => { throw new Error("recipient not allowed"); },
      gateOutbound: async () => {},
      assertUnderSendCap: async () => {},
      append: async () => {},
    }),
  );
  assert.equal(posts.length, 0);

  // allowed -> one post, correct thread, body posted verbatim (no `from` anywhere
  // in the call surface -- the fake adapter/chat above carry no `from` at all,
  // and sendNew never threads one through)
  await sendNew("ok@example.com", "s", "body", {
    adapter: fakeAdapter,
    chat: fakeChat,
    resolveRecipient: (x: string) => x,
    gateOutbound: async () => {},
    assertUnderSendCap: async () => {},
    append: async () => {},
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0], "body");
});

test("send runs the guards in order: recipient -> moderation -> send-cap -> post", async () => {
  const order: string[] = [];
  const fakeChat = { thread: async () => ({ post: async () => { order.push("post"); return { id: "x" }; } }) };
  const fakeAdapter = { openDM: async (to: string) => `resend:${to}:hash` };
  await sendNew("ok@example.com", "s", "body", {
    adapter: fakeAdapter,
    chat: fakeChat,
    resolveRecipient: (x: string) => { order.push("recipient"); return x; },
    gateOutbound: async () => { order.push("moderation"); },
    assertUnderSendCap: async () => { order.push("cap"); },
    append: async () => { order.push("append"); },
  });
  assert.deepEqual(order, ["recipient", "moderation", "cap", "post", "append"]);
});

test("reply re-validates the correspondent and refuses an unknown thread", async () => {
  const posts: unknown[] = [];
  const fakeChat = { thread: async (_threadId: string) => ({ post: async (m: unknown) => { posts.push(m); return { id: "x" }; } }) };

  // unknown thread -> throws, no post (a model-supplied threadId with no thread-index
  // entry must not be treated as pre-authorized)
  await assert.rejects(() =>
    sendReply("resend:me@bax.bot:unknown", "body", {
      adapter: {},
      chat: fakeChat,
      correspondentForThread: () => null,
      resolveRecipient: (x: string) => x,
      gateOutbound: async () => {},
      assertUnderSendCap: async () => {},
      append: async () => {},
    }),
  );
  assert.equal(posts.length, 0);

  // known but now-disallowed correspondent -> throws, no post (the allowlist is
  // re-checked at reply time, not trusted from inbound ingest)
  await assert.rejects(() =>
    sendReply("resend:me@bax.bot:abc", "body", {
      adapter: {},
      chat: fakeChat,
      correspondentForThread: () => "blocked@evil.com",
      resolveRecipient: () => { throw new Error("recipient not allowed"); },
      gateOutbound: async () => {},
      assertUnderSendCap: async () => {},
      append: async () => {},
    }),
  );
  assert.equal(posts.length, 0);

  // known + allowed -> one post, and the correspondent (not the threadId) is what
  // gets validated/appended
  let validated: string | undefined;
  let appendedTo: string | undefined;
  await sendReply("resend:me@bax.bot:abc", "body", {
    adapter: {},
    chat: fakeChat,
    correspondentForThread: () => "friend@example.com",
    resolveRecipient: (x: string) => { validated = x; return x; },
    gateOutbound: async () => {},
    assertUnderSendCap: async () => {},
    append: async (to: string) => { appendedTo = to; },
  });
  assert.equal(posts.length, 1);
  assert.equal(validated, "friend@example.com");
  assert.equal(appendedTo, "friend@example.com");
});

test("no from parameter is accepted anywhere in the CLI arg surface", async () => {
  // sendNew/sendReply/sendCalendar signatures take (to|threadId, subject?, body,
  // icsPath?, deps) -- assert no 'from' arg leaks into any of them.
  assert.equal(sendNew.length <= 4, true);
  assert.equal(sendReply.length <= 3, true);
  assert.equal(sendCalendar.length <= 5, true);
});

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
      adapter: {},
      chat: {},
      resend: () => fakeResend,
      resolveRecipient: () => { throw new Error("recipient not allowed"); },
      gateOutbound: async () => {},
      assertUnderSendCap: async () => {},
      append: async () => {},
    }),
  );
  assert.equal(sent.length, 0);

  await sendCalendar("ok@example.com", "Invite", "body", icsPath, {
    adapter: {},
    chat: {},
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
