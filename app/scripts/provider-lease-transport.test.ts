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

test("a response may cross its initial permit expiry when the bound generation renews", async () => {
  let now = 100;
  const calls: string[] = [];
  const control = fake(calls); control.providerCallPermit = async () => { calls.push("permit"); return { permit: "short", leaseGeneration: "g1", expiresAt: 110 }; };
  const transport = new ProviderLeaseTransport(control, binding, async () => { now = 111; return new Response("late but authorized"); }, () => now);
  assert.equal(await (await transport.fetch("https://provider.example")).text(), "late but authorized");
  assert.deepEqual(calls, ["permit", "renew"]);
});
test("post-response authority failure awaits body cancellation before fetch settles", async () => {
  let cancellationStarted!: () => void;
  const started = new Promise<void>(resolve => { cancellationStarted = resolve; });
  let releaseCancellation!: () => void;
  const released = new Promise<void>(resolve => { releaseCancellation = resolve; });
  const control = fake([]);
  const body = new ReadableStream<Uint8Array>({ cancel: async () => { cancellationStarted(); await released; } });
  let transport!: ProviderLeaseTransport;
  transport = new ProviderLeaseTransport(control, binding, async () => { transport.revoke(); return new Response(body); });
  let settled = false;
  const pending = transport.fetch("https://provider.example").finally(() => { settled = true; });
  await started;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "transport remains registered until cancellation settles");
  releaseCancellation();
  await assert.rejects(pending, LeaseRevokedError);
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

test("a pending provider permit rejection after revocation is typed as lease loss", async () => {
  let rejectPermit!: (error: Error) => void;
  const control = fake([]);
  control.providerCallPermit = () => new Promise((_resolve, reject) => { rejectPermit = reject; });
  let fetched = false;
  const transport = new ProviderLeaseTransport(control, binding, async () => { fetched = true; return new Response("late"); });
  const pending = transport.fetch("https://provider.example");
  await new Promise(resolve => setImmediate(resolve));
  transport.revoke();
  rejectPermit(new Error("control request closed"));
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

test("a direct stream crosses initial permit expiry and renews before every released chunk", async () => {
  let now = 100;
  const calls: string[] = [];
  const control = fake(calls);
  control.providerCallPermit = async () => { calls.push("permit"); return { permit: "short", leaseGeneration: "g1", expiresAt: 110 }; };
  control.renew = async () => { calls.push(`renew:${now}`); };
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("before"));
      controller.enqueue(encoder.encode("after"));
      controller.close();
    },
  });
  const reader = (await new ProviderLeaseTransport(control, binding, async () => new Response(body), () => now)
    .fetch("https://provider.example")).body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "before");
  now = 111;
  assert.equal(new TextDecoder().decode((await reader.read()).value), "after");
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(calls, ["permit", "renew:100", "renew:111", "renew:111"]);
});

test("the first direct stream read refuses provider bytes until authoritative renewal", async () => {
  const secret = new TextEncoder().encode("provider-secret");
  let renewalStarted!: () => void;
  const started = new Promise<void>(resolve => { renewalStarted = resolve; });
  let rejectRenewal!: (error: Error) => void;
  const control = fake([]);
  control.renew = () => {
    renewalStarted();
    return new Promise<void>((_resolve, reject) => { rejectRenewal = reject; });
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(secret); controller.close(); },
  });
  const transport = new ProviderLeaseTransport(control, binding, async () => new Response(body));
  const reader = (await transport.fetch("https://provider.example")).body!.getReader();
  let settled = false;
  const firstRead = reader.read().finally(() => { settled = true; });
  await started;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "the queued first chunk remains private while renewal is pending");
  rejectRenewal(new Error("control socket unavailable"));
  await assert.rejects(firstRead, LeaseRevokedError);
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

test("a rejected body consumer still runs the final fence and lease loss takes precedence", async () => {
  const calls: string[] = [];
  const transport = new ProviderLeaseTransport(fake(calls), binding, async () => new Response("{"));
  await assert.rejects((await transport.fetch("https://provider.example")).json(), SyntaxError);
  assert.deepEqual(calls, ["permit", "renew"]);

  const control = fake([]);
  control.renew = async () => { throw new Error("control socket unavailable"); };
  const revokedTransport = new ProviderLeaseTransport(control, binding, async () => new Response("{"));
  await assert.rejects((await revokedTransport.fetch("https://provider.example")).json(), LeaseRevokedError);
});

test("a rejected direct body read still runs the final fence", async () => {
  const calls: string[] = [];
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("provider stream failed")); } });
  const transport = new ProviderLeaseTransport(fake(calls), binding, async () => new Response(body));
  const reader = (await transport.fetch("https://provider.example")).body!.getReader();
  await assert.rejects(reader.read(), /provider stream failed/);
  assert.deepEqual(calls, ["permit", "renew"]);
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

test("revocation races and rejects a hung response-body cancellation", { timeout: 1_000 }, async () => {
  let cancellationStarted = false;
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      cancellationStarted = true;
      return new Promise<void>(() => {});
    },
  });
  const transport = new ProviderLeaseTransport(fake([]), binding, async () => new Response(body));
  const response = await transport.fetch("https://provider.example");
  const cancelling = response.body!.cancel("unused");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellationStarted, true);
  transport.revoke();
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
