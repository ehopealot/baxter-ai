import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderResend } from "./provider-resend.ts";
import { LeaseRevokedError } from "./provider-lease-transport.ts";

test("raw Resend SDK sends use the injected provider transport", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createProviderResend("re_test", async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ id: "email-1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const result = await client.emails.send({ from: "Baxter <b@example.com>", to: "a@example.com", subject: "hi", text: "hello" });
  assert.equal(result.data?.id, "email-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer re_test");
});

test("Resend SDK does not translate lease revocation into an ordinary provider error", async () => {
  const client = createProviderResend("re_test", async () => { throw new LeaseRevokedError(); });
  await assert.rejects(
    client.emails.send({ from: "Baxter <b@example.com>", to: "a@example.com", subject: "hi", text: "hello" }),
    LeaseRevokedError,
  );
});
