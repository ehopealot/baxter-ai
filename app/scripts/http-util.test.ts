import { test } from "node:test";
import assert from "node:assert/strict";
import { readCapped } from "./http-util.ts";
import { LeaseRevokedError } from "./provider-lease-transport.ts";

test("readCapped preserves typed lease revocation from capped response cancellation", async () => {
  const revoked = new LeaseRevokedError();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("too large"));
    },
    cancel() {
      throw revoked;
    },
  });

  await assert.rejects(
    readCapped(new Response(body), 3),
    error => error === revoked,
  );
});
