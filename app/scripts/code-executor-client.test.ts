import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveExecutionTransport,
  sendRemoteExecution,
} from "./code-executor-client.ts";

const keys = JSON.stringify({
  endpoint: "https://baxter-code-executor.workers.dev",
  accessKeyId: "bce1_aG9wZS1mYW1pbHk_" + "a".repeat(32),
  secretAccessKey: "a direct key that is comfortably longer than thirty-two characters",
});

test("remote execution is mandatory and local mode is rejected", () => {
  assert.throws(() => resolveExecutionTransport({ BAXTER_CODE_EXECUTOR: "local", CODE_EXECUTOR_KEYS_PATH: "/keys" }, () => keys), /local code executor has been removed/);
  assert.throws(() => resolveExecutionTransport({}, () => keys), /remote executor is not configured/);
});

test("remote mode selects a Unix signer before a direct key", () => {
  assert.deepEqual(resolveExecutionTransport({
    BAXTER_CODE_EXECUTOR: "remote",
    CODE_EXECUTOR_SOCKET: "/run/code-executor/exec.sock",
    CODE_EXECUTOR_KEYS_PATH: "/keys",
  }, () => keys), { kind: "socket", path: "/run/code-executor/exec.sock" });
});

test("remote direct mode validates a key file and fails closed", () => {
  assert.deepEqual(resolveExecutionTransport({
    BAXTER_CODE_EXECUTOR: "remote",
    CODE_EXECUTOR_KEYS_PATH: "/keys",
  }, () => keys), {
    kind: "direct",
    endpoint: "https://baxter-code-executor.workers.dev/",
    accessKeyId: "bce1_aG9wZS1mYW1pbHk_" + "a".repeat(32),
    secretAccessKey: "a direct key that is comfortably longer than thirty-two characters",
  });
  assert.throws(() => resolveExecutionTransport({ BAXTER_CODE_EXECUTOR: "remote" }, () => keys), /remote executor is not configured/);
  assert.throws(() => resolveExecutionTransport({ BAXTER_CODE_EXECUTOR: "what" }, () => keys), /invalid BAXTER_CODE_EXECUTOR/);
  assert.throws(() => resolveExecutionTransport({ BAXTER_CODE_EXECUTOR: "remote", CODE_EXECUTOR_KEYS_PATH: "/keys" }, () => "{}"), /invalid remote executor key file/);
});

test("direct transport signs the exact execution body and signer transport delegates nonce ownership", async () => {
  const direct = resolveExecutionTransport({ BAXTER_CODE_EXECUTOR: "remote", CODE_EXECUTOR_KEYS_PATH: "/keys" }, () => keys);
  const body = { language: "python", source: "print(1)", artifactBoundary: "BAX-test" };
  let signed: Request | undefined;
  const directResult = await sendRemoteExecution(body, direct, {
    nonce: () => "4604df37-8ac9-4305-9a13-bf4f25c3d2e9",
    fetch: async (request) => {
      signed = request;
      return new Response(JSON.stringify({ ok: true, stdout: "1\n", stderr: "", duration: 1 }));
    },
  });
  assert.deepEqual(directResult, { ok: true, stdout: "1\n", stderr: "", duration: 1 });
  assert.equal(await signed?.text(), JSON.stringify(body));
  assert.match(signed?.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 /);
  assert.equal(signed?.headers.get("x-baxter-nonce"), "4604df37-8ac9-4305-9a13-bf4f25c3d2e9");

  const socketResult = await sendRemoteExecution(body, { kind: "socket", path: "/run/signer.sock" }, {
    postSocket: async (path, raw) => {
      assert.equal(path, "/run/signer.sock");
      assert.equal(raw, JSON.stringify(body));
      return { status: 200, body: JSON.stringify({ ok: true, stdout: "2\n", stderr: "", duration: 2 }) };
    },
  });
  assert.deepEqual(socketResult, { ok: true, stdout: "2\n", stderr: "", duration: 2 });
});
