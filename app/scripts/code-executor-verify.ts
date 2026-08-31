import { lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sendRemoteExecution, type RemoteCodeResult } from "./code-executor-client.ts";

const SOCKET_PATH = "/run/code-executor/exec.sock";
const JOB_UID = 1000;
const JOB_GID = 1000;

interface SocketStat {
  isSocket(): boolean;
  mode: number;
  uid: number;
  gid: number;
}

export async function verifyCodeExecutorSigner({
  socketPath = SOCKET_PATH,
  stat = lstatSync,
  send = (body: Record<string, unknown>) => sendRemoteExecution(body, { kind: "socket", path: socketPath }),
}: {
  socketPath?: string;
  stat?: (path: string) => SocketStat;
  send?: (body: Record<string, unknown>) => Promise<RemoteCodeResult>;
} = {}): Promise<void> {
  const socket = stat(socketPath);
  if (!socket.isSocket() || (socket.mode & 0o777) !== 0o660 || socket.uid !== JOB_UID || socket.gid !== JOB_GID) {
    throw new Error("unsafe code executor signer socket");
  }
  const result = await send({
    language: "python",
    source: "print('executor verifier')",
    artifactBoundary: "BAX-executor-verifier",
  });
  if (!result.ok || !result.stdout.includes("executor verifier")) {
    throw new Error("code executor signer verification failed");
  }
}

async function main(): Promise<void> {
  try {
    await verifyCodeExecutorSigner();
    console.log("code executor signer verified");
  } catch {
    // This runs within the signer container: never disclose its environment or
    // upstream credential state through the host lifecycle command.
    console.error("code executor signer verification failed");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
