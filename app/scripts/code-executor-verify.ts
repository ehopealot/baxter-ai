import { fileURLToPath } from "node:url";
import {
  resolveExecutionTransport,
  sendRemoteExecution,
  type RemoteCodeResult,
} from "./code-executor-client.ts";

const IDENTITY_CANARY_MARKER = "executor identity verifier";
const IDENTITY_CANARY_SOURCE = [
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
  `print('${IDENTITY_CANARY_MARKER}')`,
].join("\n");

type Send = (body: Record<string, unknown>) => Promise<RemoteCodeResult>;

export async function verifyCodeExecutor({
  send = (body: Record<string, unknown>) => sendRemoteExecution(body, resolveExecutionTransport()),
}: {
  send?: Send;
} = {}): Promise<void> {
  const result = await send({
    language: "python",
    source: IDENTITY_CANARY_SOURCE,
    artifactBoundary: "BAX-executor-verifier",
  });
  if (!result.ok || !result.stdout.includes(IDENTITY_CANARY_MARKER)) {
    throw new Error("code executor verification failed");
  }
}

async function main(): Promise<void> {
  try {
    await verifyCodeExecutor();
    console.log("code executor verified");
  } catch {
    // Never disclose app credentials or upstream state through this operator command.
    console.error("code executor verification failed");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
