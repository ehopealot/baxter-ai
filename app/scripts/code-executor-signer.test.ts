import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodeExecutorSigner } from "./code-executor-signer.ts";

function request(socketPath: string, path: string, body = "") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      let response = "";
      res.on("data", (chunk) => (response += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: response }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("signer serves only bounded execution requests over a Unix socket", async () => {
  const socketPath = join(mkdtempSync(join(tmpdir(), "code-signer-")), "exec.sock");
  let signedBody: Record<string, unknown> | undefined;
  const server = createCodeExecutorSigner({
    send: async (body) => {
      signedBody = body;
      return { ok: true, stdout: "ok\n", stderr: "", duration: 1 };
    },
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const denied = await request(socketPath, "/not-exec", "{}");
  assert.equal(denied.status, 404);
  const allowed = await request(socketPath, "/v1/exec", JSON.stringify({ language: "python", source: "print(1)", artifactBoundary: "BAX-test" }));
  await new Promise<void>((resolve) => server.close(() => resolve()));

  assert.equal(allowed.status, 200);
  assert.deepEqual(JSON.parse(allowed.body), { ok: true, stdout: "ok\n", stderr: "", duration: 1 });
  assert.deepEqual(signedBody, { language: "python", source: "print(1)", artifactBoundary: "BAX-test" });
});
