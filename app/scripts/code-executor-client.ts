import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { AwsClient } from "aws4fetch";

export interface DirectExecutorTransport {
  kind: "direct";
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type ExecutionTransport =
  | { kind: "socket"; path: string }
  | DirectExecutorTransport;

type Env = Record<string, string | undefined>;
type ReadKeys = (path: string) => string;

function parseDirectKeys(raw: string): DirectExecutorTransport {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid remote executor key file");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid remote executor key file");
  const keys = value as Record<string, unknown>;
  if (typeof keys.endpoint !== "string" || typeof keys.accessKeyId !== "string" ||
    typeof keys.secretAccessKey !== "string" || keys.secretAccessKey.length < 32) {
    throw new Error("invalid remote executor key file");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(keys.endpoint);
  } catch {
    throw new Error("invalid remote executor key file");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error("invalid remote executor key file");
  }
  return {
    kind: "direct",
    endpoint: endpoint.toString(),
    accessKeyId: keys.accessKeyId,
    secretAccessKey: keys.secretAccessKey,
  };
}

export function resolveExecutionTransport(
  env: Env = process.env,
  readKeys: ReadKeys = (path) => readFileSync(path, "utf8"),
): ExecutionTransport {
  const mode = env.BAXTER_CODE_EXECUTOR;
  if (mode === "local") throw new Error("local code executor has been removed");
  if (mode !== undefined && mode !== "" && mode !== "remote") throw new Error("invalid BAXTER_CODE_EXECUTOR");

  const socket = env.CODE_EXECUTOR_SOCKET;
  if (socket) {
    if (!socket.startsWith("/") || socket.includes("\0")) throw new Error("invalid remote executor socket");
    return { kind: "socket", path: socket };
  }

  const keyPath = env.CODE_EXECUTOR_KEYS_PATH;
  if (!keyPath) throw new Error("remote executor is not configured");
  try {
    return parseDirectKeys(readKeys(keyPath));
  } catch (error) {
    if (error instanceof Error && error.message === "invalid remote executor key file") throw error;
    throw new Error("invalid remote executor key file");
  }
}

export const MAX_REMOTE_RESPONSE_BYTES = 32_000_000;

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

export async function postSocket(path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: path,
      path: "/v1/exec",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_REMOTE_RESPONSE_BYTES) {
          request.destroy(new Error("remote executor response too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 502, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(body);
  });
}

export async function sendRemoteExecution(
  body: Record<string, unknown>,
  transport: ExecutionTransport,
  options: {
    nonce?: () => string;
    fetch?: (request: Request) => Promise<Response>;
    postSocket?: (path: string, body: string) => Promise<{ status: number; body: string }>;
  } = {},
): Promise<RemoteCodeResult> {
  const raw = JSON.stringify(body);
  if (transport.kind === "socket") {
    const response = await (options.postSocket ?? postSocket)(transport.path, raw);
    if (response.status < 200 || response.status >= 300) throw new Error(`remote executor request failed (${response.status})`);
    if (Buffer.byteLength(response.body) > MAX_REMOTE_RESPONSE_BYTES) throw new Error("remote executor response too large");
    return parseRemoteResult(response.body);
  }

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
  const response = await (options.fetch ?? fetch)(request);
  if (!response.ok) throw new Error(`remote executor request failed (${response.status})`);
  return parseRemoteResult(await readResponse(response));
}
