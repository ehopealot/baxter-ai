import assert from "node:assert/strict";
import test from "node:test";
import { verifyCodeExecutorSigner } from "./code-executor-verify.ts";

const identityCanarySource = [
  "import os",
  "identity = (os.getuid(), os.geteuid(), os.getgid(), os.getegid())",
  "if identity != (10001, 10001, 10001, 10001) or os.getgroups() != []: raise RuntimeError('identity')",
  "status = dict(line.split(':', 1) for line in open('/proc/self/status'))",
  "if status.get('NoNewPrivs', '').strip() != '1': raise RuntimeError('identity')",
  "for field in ('CapInh', 'CapPrm', 'CapEff', 'CapAmb'):",
  " if int(status.get(field, 'not-a-hex'), 16) != 0: raise RuntimeError('identity')",
  "try:",
  " os.setuid(0)",
  "except OSError:",
  " pass",
  "else:",
  " raise RuntimeError('identity')",
  "print('executor identity verifier')",
].join("\n");

test("signer verifier requires the exact non-root Unix socket before an identity canary", async () => {
  const sent: Record<string, unknown>[] = [];
  await verifyCodeExecutorSigner({
    socketPath: "/run/code-executor/exec.sock",
    stat: () => ({ isSocket: () => true, mode: 0o140660, uid: 1000, gid: 1000 }),
    send: async (body) => {
      sent.push(body);
      return { ok: true, stdout: "executor identity verifier\n", stderr: "", duration: 1 };
    },
  });
  assert.deepEqual(sent, [{
    language: "python",
    source: identityCanarySource,
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
