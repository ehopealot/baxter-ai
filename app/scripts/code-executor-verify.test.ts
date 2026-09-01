import assert from "node:assert/strict";
import test from "node:test";
import { verifyCodeExecutor } from "./code-executor-verify.ts";

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

test("direct verifier sends the fixed identity canary without a Unix socket", async () => {
  const sent: Record<string, unknown>[] = [];
  await verifyCodeExecutor({
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

test("direct verifier keeps failed canary output private", async () => {
  await assert.rejects(
    verifyCodeExecutor({
      send: async () => ({ ok: false, stdout: "sensitive", stderr: "sensitive", duration: 1 }),
    }),
    /code executor verification failed/,
  );
});
