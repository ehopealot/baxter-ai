import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderLeaseTransport, LeaseRevokedError, cancelProviderResponse } from "./provider-lease-transport.ts";
import { lifecycleControl } from "./worker-control.ts";
import type { WorkerBinding, WorkerControlClient } from "./worker-control.ts";

const binding: WorkerBinding = { tenantId: "t", containerId: "a".repeat(64), leaseGeneration: "g1", policyGeneration: 2, policyDigest: "digest", launchFingerprint: "fingerprint" };
function fake(calls: string[], revocationSignal = new AbortController().signal): WorkerControlClient {
  return {
    hello: async () => { calls.push("hello"); }, renew: async () => { calls.push("renew"); },
    providerCallPermit: async () => { calls.push("permit"); return { permit: "one", leaseGeneration: "g1", expiresAt: Date.now() + 1000 }; },
    revocationSignal: () => revocationSignal,
    coverage: async () => { calls.push("coverage"); }, exitPermitted: async () => { calls.push("exit"); return { permitted: true }; }, drain: async () => { calls.push("drain"); },
  };
}
test("typed worker lifecycle forwards hello, renew, coverage, exit permission, and drain", async () => {
  const calls: string[] = [];
  const control = lifecycleControl(fake(calls), binding);
  await control.hello(); await control.renew(); await control.coverage({ queue: "mail", highWater: 7 });
  assert.equal(await control.exitPermitted(), true);
  await control.drain();
  assert.deepEqual(calls, ["hello", "renew", "coverage", "exit", "drain"]);
});

test("provider transport validates a fresh matching permit without leaking it to the provider", async () => {
  const calls: string[] = []; let header = "";
  const transport = new ProviderLeaseTransport(fake(calls), binding, async (_url, init) => { header = new Headers(init?.headers).get("x-baxter-provider-permit") ?? ""; return new Response("ok"); });
  const request = new Request("https://provider.example", { headers: { "x-baxter-provider-permit": "stale-caller-copy" } });
  assert.equal(await (await transport.fetch(request)).text(), "ok");
  assert.deepEqual(calls, ["permit", "renew"]); assert.equal(header, "");
});

test("provider transport rejects expired and mismatched-generation permits before fetch", async () => {
  for (const permit of [
    { permit: "expired", leaseGeneration: "g1", expiresAt: Date.now() - 1 },
    { permit: "wrong", leaseGeneration: "g2", expiresAt: Date.now() + 10_000 },
  ]) {
    let fetched = false;
    const control = fake([]); control.providerCallPermit = async () => permit;
    const transport = new ProviderLeaseTransport(control, binding, async () => { fetched = true; return new Response("no"); });
    await assert.rejects(transport.fetch("https://provider.example"), LeaseRevokedError);
    assert.equal(fetched, false);
  }
});

test("a permit expiring while the provider is in flight rejects the late response", async () => {
  let now = 100;
  const control = fake([]); control.providerCallPermit = async () => ({ permit: "short", leaseGeneration: "g1", expiresAt: 110 });
  const transport = new ProviderLeaseTransport(control, binding, async () => { now = 111; return new Response("late"); }, () => now);
  await assert.rejects(transport.fetch("https://provider.example"), LeaseRevokedError);
});
test("the worker-control revocation signal aborts in-flight work without waiting for another RPC", async () => {
  const revoked = new AbortController();
  let fetchSignal!: AbortSignal;
  const transport = new ProviderLeaseTransport(fake([], revoked.signal), binding, async (_input, init) => {
    fetchSignal = init!.signal!;
    return new Promise<Response>((_resolve, reject) => fetchSignal.addEventListener("abort", () => reject(fetchSignal.reason), { once: true }));
  });
  const pending = transport.fetch("https://provider.example");
  await new Promise(resolve => setImmediate(resolve));
  revoked.abort();
  assert.equal(fetchSignal.aborted, true);
  await assert.rejects(pending, LeaseRevokedError);
});

test("a provider permit resolving after revocation is rejected before fetch", async () => {
  let resolvePermit!: (permit: { permit: string; leaseGeneration: string; expiresAt: number }) => void;
  const control = fake([]);
  control.providerCallPermit = () => new Promise(resolve => { resolvePermit = resolve; });
  let fetched = false;
  const transport = new ProviderLeaseTransport(control, binding, async () => { fetched = true; return new Response("late"); });
  const pending = transport.fetch("https://provider.example");
  await new Promise(resolve => setImmediate(resolve));
  transport.revoke();
  resolvePermit({ permit: "late", leaseGeneration: "g1", expiresAt: Date.now() + 10_000 });
  await assert.rejects(pending, LeaseRevokedError);
  assert.equal(fetched, false);
});

test("revocation aborts in-flight work and late results are rejected", async () => {
  let release!: () => void;
  const transport = new ProviderLeaseTransport(fake([]), binding, async () => new Promise<Response>((resolve) => { release = () => resolve(new Response("late")); }));
  const pending = transport.fetch("https://provider.example"); await new Promise((resolve) => setImmediate(resolve)); transport.revoke(); release();
  await assert.rejects(pending, LeaseRevokedError);
});

test("response publication remains lease-fenced through body parsing", async () => {
  const calls: string[] = [];
  let releaseBody!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'));
      releaseBody = () => { controller.enqueue(new TextEncoder().encode("true}")); controller.close(); };
    },
  });
  const transport = new ProviderLeaseTransport(fake(calls), binding, async () => new Response(body));
  const response = await transport.fetch("https://provider.example");
  const parsed = response.json();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["permit"], "renew waits until the response body is fully parsed");
  releaseBody();
  assert.deepEqual(await parsed, { ok: true });
  assert.deepEqual(calls, ["permit", "renew"]);
});

test("cloned response bodies remain fenced through their own parse", async () => {
  const calls: string[] = [];
  const transport = new ProviderLeaseTransport(fake(calls), binding, async () => new Response('{"ok":true}'));
  const response = await transport.fetch("https://provider.example");
  const clone = response.clone();
  assert.deepEqual(await clone.json(), { ok: true });
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(calls, ["permit", "renew", "renew"]);
});

test("body cancellation completes only after renewal and a final authority validation", async () => {
  const calls: string[] = [];
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
  const transport = new ProviderLeaseTransport(fake(calls), binding, async () => new Response(body));
  const response = await transport.fetch("https://provider.example");
  await response.body!.cancel("unused");
  assert.equal(cancelled, true);
  assert.deepEqual(calls, ["permit", "renew"]);
});

test("status-only callers await body cancellation and the permit's final renewal", async () => {
  const calls: string[] = [];
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ cancel: async () => { await Promise.resolve(); cancelled = true; } }), { status: 202 });
  const transport = new ProviderLeaseTransport(fake(calls), binding, async () => response);
  const statusOnly = await transport.fetch("https://provider.example");
  await cancelProviderResponse(statusOnly);
  assert.equal(cancelled, true);
  assert.deepEqual(calls, ["permit", "renew"]);
});

test("post-consumption renewal failures are centrally converted to typed lease revocation", async () => {
  for (const finish of [
    async (response: Response) => { await response.text(); },
    async (response: Response) => { await response.body!.cancel("unused"); },
  ]) {
    const control = fake([]);
    control.renew = async () => { throw new Error("control socket unavailable"); };
    const transport = new ProviderLeaseTransport(control, binding, async () => new Response("provider output"));
    const response = await transport.fetch("https://provider.example");
    await assert.rejects(finish(response), LeaseRevokedError);
    await assert.rejects(transport.fetch("https://provider.example"), LeaseRevokedError, "an uncertain renewal permanently closes this transport");
  }
});

test("revocation during body cancellation rejects instead of reporting an authorized cancel", async () => {
  const revoked = new AbortController();
  let releaseCancel!: () => void;
  const body = new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(resolve => { releaseCancel = resolve; }) });
  const transport = new ProviderLeaseTransport(fake([], revoked.signal), binding, async () => new Response(body));
  const response = await transport.fetch("https://provider.example");
  const cancelling = response.body!.cancel("unused");
  await new Promise(resolve => setImmediate(resolve));
  revoked.abort(); releaseCancel();
  await assert.rejects(cancelling, LeaseRevokedError);
});

test("revocation aborts response-body parsing and never publishes parsed provider data", async () => {
  let fetchSignal!: AbortSignal;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"secret":')); },
  });
  const transport = new ProviderLeaseTransport(fake([]), binding, async (_input, init) => {
    fetchSignal = init!.signal!;
    return new Response(body);
  });
  const response = await transport.fetch("https://provider.example");
  const parsed = response.json();
  transport.revoke();
  assert.equal(fetchSignal.aborted, true);
  await assert.rejects(parsed, LeaseRevokedError);
});
