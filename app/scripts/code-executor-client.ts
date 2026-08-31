import { randomUUID } from "node:crypto";
import { AwsClient } from "aws4fetch";

export interface DirectExecutorTransport {
  kind: "direct";
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

type Env = Record<string, string | undefined>;

const ACCESS_KEY = /^bce1_[A-Za-z0-9_-]+_[a-f0-9]{32}$/;
const BOUNDARY = /^[A-Za-z0-9-]{4,128}$/;
export const MAX_SOURCE_BYTES = 512 * 1024;
export const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 6 * (MAX_SOURCE_BYTES + MAX_INPUT_BYTES) + 8 * 1024;

function validExecution(body: Record<string, unknown>): boolean {
  return (body.language === "python" || body.language === "node") &&
    typeof body.source === "string" && Buffer.byteLength(body.source) <= MAX_SOURCE_BYTES &&
    (body.input === undefined || (typeof body.input === "string" && Buffer.byteLength(body.input) <= MAX_INPUT_BYTES)) &&
    typeof body.artifactBoundary === "string" && BOUNDARY.test(body.artifactBoundary);
}

export function resolveExecutionTransport(env: Env = process.env): DirectExecutorTransport {
  const mode = env.BAXTER_CODE_EXECUTOR;
  if (mode === "local") throw new Error("local code executor has been removed");
  if (mode !== "remote") {
    if (mode === undefined || mode === "") throw new Error("remote executor is not configured");
    throw new Error("invalid BAXTER_CODE_EXECUTOR");
  }
  if (env.CODE_EXECUTOR_SOCKET) throw new Error("remote executor socket transport has been removed");
  if (env.CODE_EXECUTOR_KEYS_PATH) throw new Error("remote executor key-file transport has been removed");

  const endpoint = env.CODE_EXECUTOR_URL;
  const accessKeyId = env.CODE_EXECUTOR_ACCESS_KEY_ID;
  const secretAccessKey = env.CODE_EXECUTOR_SECRET_ACCESS_KEY;
  if (typeof endpoint !== "string" || typeof accessKeyId !== "string" || typeof secretAccessKey !== "string" ||
    !ACCESS_KEY.test(accessKeyId) || secretAccessKey.length < 32) {
    throw new Error("invalid remote executor credentials");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("invalid remote executor credentials");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("invalid remote executor credentials");
  }
  return {
    kind: "direct",
    endpoint: url.toString(),
    accessKeyId,
    secretAccessKey,
  };
}

export const MAX_REMOTE_RESPONSE_BYTES = 32_000_000;
// Above Worker 60s lease/reaper bounds, but finite so an unreachable Worker
// cannot hold an agent run indefinitely.
export const REMOTE_EXECUTION_TIMEOUT_MS = 70_000;

export interface RemoteCodeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  duration: number;
}

function parseRemoteResult(raw: string): RemoteCodeResult {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("invalid remote executor response"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid remote executor response");
  const result = value as Record<string, unknown>;
  if (typeof result.ok !== "boolean" || typeof result.stdout !== "string" || typeof result.stderr !== "string" ||
    typeof result.duration !== "number" || !Number.isSafeInteger(result.duration) || result.duration < 0) {
    throw new Error("invalid remote executor response");
  }
  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr, duration: result.duration };
}

async function readResponse(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_REMOTE_RESPONSE_BYTES)) {
    throw new Error("remote executor response too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REMOTE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("remote executor response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function sendRemoteExecution(
  body: Record<string, unknown>,
  transport: DirectExecutorTransport,
  options: {
    nonce?: () => string;
    fetch?: (request: Request) => Promise<Response>;
  } = {},
): Promise<RemoteCodeResult> {
  if (!validExecution(body)) throw new Error("invalid remote executor request");
  let raw: string;
  try {
    raw = JSON.stringify(body);
  } catch {
    throw new Error("invalid remote executor request");
  }
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) throw new Error("invalid remote executor request");
  const client = new AwsClient({
    accessKeyId: transport.accessKeyId,
    secretAccessKey: transport.secretAccessKey,
    service: "code-executor",
    region: "auto",
  });
  const request = await client.sign(new URL("/v1/exec", transport.endpoint).toString(), {
    method: "POST",
    body: raw,
    headers: { "content-type": "application/json", "x-baxter-nonce": (options.nonce ?? randomUUID)() },
    aws: { allHeaders: true },
  });
  const fetchImpl = options.fetch ?? ((signed: Request) => fetch(signed, { signal: AbortSignal.timeout(REMOTE_EXECUTION_TIMEOUT_MS) }));
  const response = await fetchImpl(request);
  if (!response.ok) throw new Error(`remote executor request failed (${response.status})`);
  return parseRemoteResult(await readResponse(response));
}
