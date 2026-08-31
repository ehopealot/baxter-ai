import assert from "node:assert/strict";
import test from "node:test";
import { verifyCodeExecutorSigner } from "./code-executor-verify.ts";

test("signer verifier requires the exact non-root Unix socket before a no-op", async () => {
  const sent: Record<string, unknown>[] = [];
  await verifyCodeExecutorSigner({
    socketPath: "/run/code-executor/exec.sock",
    stat: () => ({ isSocket: () => true, mode: 0o140660, uid: 1000, gid: 1000 }),
    send: async (body) => {
      sent.push(body);
      return { ok: true, stdout: "executor verifier\n", stderr: "", duration: 1 };
    },
  });
  assert.deepEqual(sent, [{
    language: "python",
    source: "print('executor verifier')",
    artifactBoundary: "BAX-executor-verifier",
  }]);
});

test("signer verifier refuses an unsafe socket before sending", async () => {
  await assert.rejects(
    verifyCodeExecutorSigner({
      socketPath: "/run/code-executor/exec.sock",
      stat: () => ({ isSocket: () => false, mode: 0o100660, uid: 0, gid: 0 }),
      send: async () => ({ ok: true, stdout: "", stderr: "", duration: 1 }),
    }),
    /unsafe code executor signer socket/,
  );
});
