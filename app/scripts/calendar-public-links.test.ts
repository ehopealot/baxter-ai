// Core-side client for the Worker-issued public calendar capability. It uses the
// existing per-tenant SigV4 credential, never a new bearer-signing secret.
import { test } from "node:test";
import assert from "node:assert/strict";

const KEYS = {
  endpoint: "https://home.example.test/svc/hopefam",
  tenant: "hopefam",
  accessKeyId: "AKIDEXAMPLE0000000000000",
  secretAccessKey: "s3cret-shhh-0000000000000000",
};
const ISSUE = {
  event: {
    uid: "event-1@baxter",
    title: "Dentist",
    start: "2026-08-10T22:00:00.000Z",
    end: "2026-08-10T23:00:00.000Z",
    allDay: false,
    location: "Main St",
  },
  ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
};

async function client() {
  const api = await import("./calendar-public-links.ts") as Record<string, unknown>;
  assert.equal(typeof api.issueCalendarPublicLink, "function", "the signed Home issuer is exported");
  return api.issueCalendarPublicLink as Function;
}

test("issueCalendarPublicLink sends exactly the canonical snapshot to the tenant-scoped signed endpoint", async () => {
  const issueCalendarPublicLink = await client();
  let captured: Request | undefined;
  const result = await issueCalendarPublicLink(ISSUE, {
    keys: KEYS,
    homeOrigin: "https://home.example.test",
    fetchFn: async (input: Parameters<typeof fetch>[0]) => {
      captured = input instanceof Request ? input.clone() : new Request(input);
      return new Response(JSON.stringify({ googleCode: "Ab3xY7kQ2m", deviceCode: "N9qL4vZ8sT", expiresAt: 123 }), { status: 200 });
    },
  });

  assert.deepEqual(result, { googleCode: "Ab3xY7kQ2m", deviceCode: "N9qL4vZ8sT", expiresAt: 123, homeOrigin: "https://home.example.test" });
  assert.ok(captured);
  assert.equal(captured!.url, "https://home.example.test/svc/hopefam/calendar-link");
  assert.equal(captured!.method, "POST");
  assert.equal(captured!.headers.get("content-type"), "application/json");
  assert.match(captured!.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 /);
  assert.match(captured!.headers.get("x-amz-date") ?? "", /^\d{8}T\d{6}Z$/);
  assert.deepEqual(JSON.parse(await captured!.text()), ISSUE, "only the canonical event and first-issued ICS cross the signed boundary");
});

test("issueCalendarPublicLink rejects legacy or malformed pair responses without exposing the Home credential", async () => {
  const issueCalendarPublicLink = await client();
  for (const body of [
    { token: "a".repeat(36), expiresAt: 123 },
    { googleCode: "Ab3xY7kQ2m", deviceCode: "Ab3xY7kQ2m", expiresAt: 123 },
    { googleCode: "not-a-code", deviceCode: "N9qL4vZ8sT", expiresAt: 123 },
  ]) {
    await assert.rejects(
      () => issueCalendarPublicLink(ISSUE, {
        keys: KEYS,
        homeOrigin: "https://home.example.test",
        fetchFn: async () => new Response(JSON.stringify(body), { status: 200 }),
      }),
      /calendar link issuance returned invalid response/,
    );
  }
});

test("issueCalendarPublicLink rejects a bad Home response without exposing the Home credential", async () => {
  const issueCalendarPublicLink = await client();
  await assert.rejects(
    () => issueCalendarPublicLink(ISSUE, {
      keys: KEYS,
      homeOrigin: "https://home.example.test",
      fetchFn: async () => new Response("upstream details", { status: 503 }),
    }),
    (err: Error) => {
      assert.match(err.message, /calendar link issuance failed/);
      assert.doesNotMatch(err.message, /s3cret-shhh/);
      return true;
    },
  );
});

test("issueCalendarPublicLink refuses a Home key endpoint outside the configured public origin", async () => {
  const issueCalendarPublicLink = await client();
  let fetched = false;
  await assert.rejects(
    () => issueCalendarPublicLink(ISSUE, {
      keys: { ...KEYS, endpoint: "https://evil.example.test/svc/hopefam" },
      homeOrigin: "https://home.example.test",
      fetchFn: async () => { fetched = true; return new Response(); },
    }),
    /home-keys\.json endpoint/,
  );
  assert.equal(fetched, false, "do not sign the Home credential for an arbitrary host");
});
