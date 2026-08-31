import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveExecutionTransport,
  sendRemoteExecution,
} from "./code-executor-client.ts";

const directEnv = {
  BAXTER_CODE_EXECUTOR: "remote",
  CODE_EXECUTOR_URL: "https://baxter-code-executor.example.workers.dev/",
  CODE_EXECUTOR_ACCESS_KEY_ID: "bce1_aG9wZS1mYW1pbHk_" + "a".repeat(32),
  CODE_EXECUTOR_SECRET_ACCESS_KEY: "s".repeat(48),
};

test("remote execution requires complete direct environment credentials", () => {
  assert.deepEqual(resolveExecutionTransport(directEnv), {
    kind: "direct",
    endpoint: "https://baxter-code-executor.example.workers.dev/",
    accessKeyId: directEnv.CODE_EXECUTOR_ACCESS_KEY_ID,
    secretAccessKey: directEnv.CODE_EXECUTOR_SECRET_ACCESS_KEY,
  });

  assert.throws(() => resolveExecutionTransport({}), /remote executor is not configured/);
  assert.throws(() => resolveExecutionTransport({ ...directEnv, BAXTER_CODE_EXECUTOR: "local" }), /local code executor has been removed/);
  assert.throws(() => resolveExecutionTransport({ ...directEnv, BAXTER_CODE_EXECUTOR: "other" }), /invalid BAXTER_CODE_EXECUTOR/);
  for (const key of ["CODE_EXECUTOR_URL", "CODE_EXECUTOR_ACCESS_KEY_ID", "CODE_EXECUTOR_SECRET_ACCESS_KEY"] as const) {
    const partial = { ...directEnv };
    delete partial[key];
    assert.throws(() => resolveExecutionTransport(partial), /invalid remote executor credentials/);
  }
});

test("direct environment transport rejects unsafe origins and retired transports", () => {
  for (const endpoint of [
    "http://baxter-code-executor.example.workers.dev/",
    "https://user:password@baxter-code-executor.example.workers.dev/",
    "https://baxter-code-executor.example.workers.dev/v1/exec",
    "https://baxter-code-executor.example.workers.dev/?key=value",
    "https://baxter-code-executor.example.workers.dev/#key",
  ]) {
    assert.throws(() => resolveExecutionTransport({ ...directEnv, CODE_EXECUTOR_URL: endpoint }), /invalid remote executor credentials/);
  }
  assert.throws(
    () => resolveExecutionTransport({ ...directEnv, CODE_EXECUTOR_SOCKET: "/run/code-executor/exec.sock" }),
    /socket transport has been removed/,
  );
  assert.throws(
    () => resolveExecutionTransport({ ...directEnv, CODE_EXECUTOR_KEYS_PATH: "/keys.json" }),
    /key-file transport has been removed/,
  );
});

test("direct transport rejects invalid or oversized bodies before fetch", async () => {
  const direct = resolveExecutionTransport(directEnv);
  const bodies = [
    { language: "ruby", source: "puts 1", artifactBoundary: "BAX-test" },
    { language: "python", source: "print(1)", artifactBoundary: "bad" },
    { language: "python", source: "x".repeat(512 * 1024 + 1), artifactBoundary: "BAX-test" },
    { language: "python", source: "print(1)", input: "x".repeat(1024 * 1024 + 1), artifactBoundary: "BAX-test" },
  ];
  for (const body of bodies) {
    let fetched = false;
    await assert.rejects(
      sendRemoteExecution(body, direct, {
        fetch: async () => {
          fetched = true;
          return new Response(JSON.stringify({ ok: true, stdout: "", stderr: "", duration: 1 }));
        },
      }),
      /invalid remote executor request/,
    );
    assert.equal(fetched, false);
  }
});

test("direct transport signs the exact execution body with a caller nonce", async () => {
  const direct = resolveExecutionTransport(directEnv);
  const body = { language: "python", source: "print(1)", artifactBoundary: "BAX-test" };
  let signed: Request | undefined;
  const result = await sendRemoteExecution(body, direct, {
    nonce: () => "4604df37-8ac9-4305-9a13-bf4f25c3d2e9",
    fetch: async (request) => {
      signed = request;
      return new Response(JSON.stringify({ ok: true, stdout: "1\n", stderr: "", duration: 1 }));
    },
  });
  assert.deepEqual(result, { ok: true, stdout: "1\n", stderr: "", duration: 1 });
  assert.equal(await signed?.text(), JSON.stringify(body));
  assert.match(signed?.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 /);
  assert.equal(signed?.headers.get("x-baxter-nonce"), "4604df37-8ac9-4305-9a13-bf4f25c3d2e9");
});
