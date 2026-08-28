import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GENERATION = "runner-test-generation";
const TOKEN = "a".repeat(64);

export interface RunnerLeaseControl {
  directory: string;
  close(): Promise<void>;
}

/** Worker-control fixture that revokes when the runner asks for one permit too many. */
export async function runnerLeaseControl(permitsBeforeRevocation: number): Promise<RunnerLeaseControl> {
  const directory = mkdtempSync(join(tmpdir(), "runner-lease-"));
  const socketPath = join(directory, "control.sock");
  writeFileSync(join(directory, "token"), TOKEN);
  writeFileSync(join(directory, "worker-binding.json"), JSON.stringify({
    version: 1,
    tenantId: "runner-test",
    containerId: "b".repeat(64),
    generation: GENERATION,
    workerPolicyGeneration: 1,
    workerPolicyDigest: "runner-test-policy",
    launchFingerprint: "runner-test-launch",
  }));

  let permits = 0;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as { requestId: string; type: string };
        if (request.type === "provider-call-permit" && ++permits > permitsBeforeRevocation) {
          socket.write(`${JSON.stringify({ version: 1, type: "revoked", generation: GENERATION, reason: "runner test revoked the lease" })}\n`);
          continue;
        }
        const result = request.type === "provider-call-permit"
          ? { permit: `permit-${permits}`, generation: GENERATION, expiresAt: Date.now() + 60_000 }
          : {};
        socket.write(`${JSON.stringify({ version: 1, requestId: request.requestId, ok: true, result })}\n`);
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });

  return {
    directory,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
