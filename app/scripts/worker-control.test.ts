import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { UnixSocketWorkerControlClient, workerControlFromEnv } from "./worker-control.ts";

const metadata = {
  version: 1,
  tenantId: "tenant-a",
  containerId: "a".repeat(64),
  generation: "lease-7",
  workerPolicyGeneration: 4,
  workerPolicyDigest: "policy-digest",
  launchFingerprint: "launch-fingerprint",
};

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "worker-control-"));
  writeFileSync(join(dir, "token"), "b".repeat(64), { mode: 0o440 });
  writeFileSync(join(dir, "worker-binding.json"), JSON.stringify(metadata), { mode: 0o440 });
  const requests: Array<Record<string, unknown>> = [];
  let peer: Socket | undefined;
  const server = createServer(socket => {
    peer = socket;
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        requests.push(request);
        const result = request.type === "provider-call-permit"
          ? { permit: "permit-1", generation: metadata.generation, expiresAt: Date.now() + 10_000 }
          : request.type === "exit-permitted" ? { permitted: false } : {};
        socket.write(`${JSON.stringify({ version: 1, requestId: request.requestId, ok: true, result })}\n`);
      }
    });
  });
  server.listen(join(dir, "control.sock"));
  await once(server, "listening");
  return {
    dir, requests,
    peer: () => peer!,
    close: async () => { peer?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("worker mode bootstraps JSONL v1 from post-inspection mounted metadata, not a pre-create container-id env", async () => {
  const f = await fixture();
  try {
    const env = { BAXTER_WORKER_MODE: "1", BAXTER_WORKER_CONTROL_DIR: f.dir, BAXTER_CONTAINER_ID: "wrong-precreate-value" };
    const { client, binding } = workerControlFromEnv(env);
    assert.ok(client instanceof UnixSocketWorkerControlClient);
    assert.deepEqual(binding, {
      tenantId: metadata.tenantId, containerId: metadata.containerId, leaseGeneration: metadata.generation,
      policyGeneration: metadata.workerPolicyGeneration, policyDigest: metadata.workerPolicyDigest,
      launchFingerprint: metadata.launchFingerprint,
    });
    await client.hello(binding!);
    const permit = await client.providerCallPermit(binding!);
    await client.coverage(binding!, { queue: "mail", highWater: 9 });
    assert.equal((await client.exitPermitted(binding!)).permitted, false);
    await client.drain(binding!);
    assert.deepEqual(f.requests.map(request => request.type), ["hello", "provider-call-permit", "coverage", "exit-permitted", "drain-now"]);
    for (const request of f.requests) {
      assert.ok(typeof request.requestId === "string");
      const fixture = {
        version: 1, requestId: "<request-id>", type: request.type, token: "b".repeat(64),
        tenantId: metadata.tenantId, containerId: metadata.containerId, generation: metadata.generation,
        workerPolicyGeneration: metadata.workerPolicyGeneration, workerPolicyDigest: metadata.workerPolicyDigest,
        launchFingerprint: metadata.launchFingerprint,
        ...(request.type === "coverage" ? { coverage: { queue: "mail", highWater: 9 } } : {}),
      };
      assert.deepEqual({ ...request, requestId: "<request-id>" }, fixture, `exact JSONL v1 ${String(request.type)} request fixture`);
    }
  } finally { await f.close(); }
});

test("the subscribed socket converts a matching revoked event into the process-local revocation signal", async () => {
  const f = await fixture();
  try {
    const client = new UnixSocketWorkerControlClient(f.dir);
    const binding = client.binding();
    await client.hello(binding);
    const signal = client.revocationSignal(binding);
    f.peer().write(`${JSON.stringify({ version: 1, type: "revoked", generation: metadata.generation, reason: "replaced" })}\n`);
    await once(signal, "abort");
    assert.equal(signal.aborted, true);
    await assert.rejects(client.providerCallPermit(binding), /revoked/);
  } finally { await f.close(); }
});

test("malformed JSONL frames and malformed revocations fail closed instead of escaping or being ignored", async () => {
  const malformed: unknown[] = [
    null,
    [],
    "not-an-object",
    { version: 1, type: "revoked", generation: null, reason: "replaced" },
    { version: 1, type: "revoked", generation: metadata.generation, reason: null },
    { version: 1, type: "revoked", generation: metadata.generation, reason: "" },
    { version: 1, type: "revoked", generation: metadata.generation, reason: "replaced", extra: true },
  ];
  for (const frame of malformed) {
    const f = await fixture();
    try {
      const client = new UnixSocketWorkerControlClient(f.dir);
      const binding = client.binding();
      await client.hello(binding);
      const signal = client.revocationSignal(binding);
      f.peer().write(`${JSON.stringify(frame)}\n`);
      await once(signal, "abort");
      assert.equal(signal.aborted, true, `frame ${JSON.stringify(frame)} must fail closed`);
      await assert.rejects(client.providerCallPermit(binding), /revoked/);
    } finally { await f.close(); }
  }
});

test("a well-formed revocation for another generation is ignored", async () => {
  const f = await fixture();
  try {
    const client = new UnixSocketWorkerControlClient(f.dir);
    const binding = client.binding();
    await client.hello(binding);
    f.peer().write(`${JSON.stringify({ version: 1, type: "revoked", generation: "another-generation", reason: "replaced" })}\n`);
    assert.equal((await client.providerCallPermit(binding)).leaseGeneration, metadata.generation);
    assert.equal(client.revocationSignal(binding).aborted, false);
  } finally { await f.close(); }
});

test("worker bootstrap fails closed when post-inspection metadata is missing or malformed", () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-control-invalid-"));
  try {
    writeFileSync(join(dir, "token"), "b".repeat(64));
    assert.throws(() => workerControlFromEnv({ BAXTER_WORKER_MODE: "1", BAXTER_WORKER_CONTROL_DIR: dir }), /worker-binding\.json|ENOENT/);
    writeFileSync(join(dir, "worker-binding.json"), JSON.stringify({ ...metadata, containerId: "short" }));
    assert.throws(() => workerControlFromEnv({ BAXTER_WORKER_MODE: "1", BAXTER_WORKER_CONTROL_DIR: dir }), /metadata is invalid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
