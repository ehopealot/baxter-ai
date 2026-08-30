#!/usr/bin/env node
// Minimal local relay for remote code execution. It has the tenant's executor
// key, but binds only a Unix socket shared with app containers; it never runs
// tenant code or exposes a TCP listener.
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";
import {
  sendRemoteExecution,
  type DirectExecutorTransport,
  type RemoteCodeResult,
} from "./code-executor-client.ts";

const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = MAX_SOURCE_BYTES + MAX_INPUT_BYTES + 8 * 1024;
const BOUNDARY = /^[A-Za-z0-9-]{4,128}$/;

type Send = (body: Record<string, unknown>) => Promise<RemoteCodeResult>;

function bytes(value: string): number { return Buffer.byteLength(value); }

function validExecution(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (body.language === "python" || body.language === "node") &&
    typeof body.source === "string" && bytes(body.source) <= MAX_SOURCE_BYTES &&
    (body.input === undefined || (typeof body.input === "string" && bytes(body.input) <= MAX_INPUT_BYTES)) &&
    typeof body.artifactBoundary === "string" && BOUNDARY.test(body.artifactBoundary);
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += data.length;
    if (total > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createCodeExecutorSigner({ send }: { send: Send }): http.Server {
  return http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/exec" || !/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }
    try {
      const raw = await readBody(request);
      const body: unknown = JSON.parse(raw);
      if (!validExecution(body)) {
        response.statusCode = 400;
        response.end("Invalid request");
        return;
      }
      const result = await send(body);
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(result));
    } catch {
      // Never echo source, a key, signed headers, or an upstream error here.
      response.statusCode = 502;
      response.end("Executor unavailable");
    }
  });
}

function transportFromEnv(env: NodeJS.ProcessEnv = process.env): DirectExecutorTransport {
  const endpoint = env.CODE_EXECUTOR_URL;
  const accessKeyId = env.CODE_EXECUTOR_ACCESS_KEY_ID;
  const secretAccessKey = env.CODE_EXECUTOR_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey || secretAccessKey.length < 32) throw new Error("signer is not configured");
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("signer is not configured");
  return { kind: "direct", endpoint: url.toString(), accessKeyId, secretAccessKey };
}

export async function startCodeExecutorSigner(env: NodeJS.ProcessEnv = process.env): Promise<http.Server> {
  const socketPath = env.CODE_EXECUTOR_SOCKET;
  if (!socketPath || !socketPath.startsWith("/") || socketPath.includes("\0")) throw new Error("signer is not configured");
  const transport = transportFromEnv(env);
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) throw new Error("signer socket path is unsafe");
    unlinkSync(socketPath);
  }
  const server = createCodeExecutorSigner({ send: (body) => sendRemoteExecution(body, transport) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      try {
        chmodSync(socketPath, 0o660);
        resolve();
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startCodeExecutorSigner().catch(() => {
    // Startup errors deliberately omit configuration values.
    process.stderr.write("code-executor-signer: unavailable\n");
    process.exit(1);
  });
}
