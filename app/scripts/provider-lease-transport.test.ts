import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderLeaseTransport, LeaseRevokedError } from "./provider-lease-transport.ts";
import type { WorkerBinding, WorkerControlClient } from "./worker-control.ts";

const binding: WorkerBinding = { tenantId: "t", containerId: "a".repeat(64), leaseGeneration: "g1", policyGeneration: 2, policyDigest: "digest", launchFingerprint: "fingerprint" };
function fake(calls: string[]): WorkerControlClient {
  return {
    hello: async () => { calls.push("hello"); }, renew: async () => { calls.push("renew"); },
    providerCallPermit: async () => { calls.push("permit"); return { permit: "one", leaseGeneration: "g1", expiresAt: Date.now() + 1000 }; },
    coverage: async () => { calls.push("coverage"); }, exitPermitted: async () => ({ permitted: true }), drain: async () => { calls.push("drain"); },
  };
}
test("provider transport consumes a permit immediately before fetch and checks generation after it", async () => {
  const calls: string[] = []; let header = "";
  const transport = new ProviderLeaseTransport(fake(calls), binding, async (_url, init) => { header = new Headers(init?.headers).get("x-baxter-provider-permit") ?? ""; return new Response("ok"); });
  assert.equal(await (await transport.fetch("https://provider.example")).text(), "ok");
  assert.deepEqual(calls, ["permit", "renew"]); assert.equal(header, "one");
});
test("revocation aborts in-flight work and late results are rejected", async () => {
  let release!: () => void;
  const transport = new ProviderLeaseTransport(fake([]), binding, async () => new Promise<Response>((resolve) => { release = () => resolve(new Response("late")); }));
  const pending = transport.fetch("https://provider.example"); await new Promise((resolve) => setImmediate(resolve)); transport.revoke(); release();
  await assert.rejects(pending, LeaseRevokedError);
});
