import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { CHAT_OUTPUT_RECEIPTS_DIR, SMS_DELIVERY_RECEIPTS_DIR } from "./paths.ts";
import { ensureDurableDirectory, syncDirectory } from "./durable-directory.ts";

export type OutputSurface = "sms" | "chat";
export interface SmsOutputOperation {
  kind: "sms";
  path: string;
  body: Record<string, unknown>;
  convId: string;
  content: string;
}
export interface ChatOutputOperation { kind: "chat"; chatId: string; content: string; authorName: string; }
export type OutputOperation = SmsOutputOperation | ChatOutputOperation;

export type OutputReceipt = {
  version: 1;
  surface: OutputSurface;
  workId: string;
  operationId: string;
  idempotencyKey: string;
  operation: OutputOperation;
  state: "prepared" | "provider-accepted" | "completed";
  preparedAt: string;
  providerId?: string;
  providerResponse?: unknown;
  acceptedAt?: string;
  completedAt?: string;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
function validWorkId(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validOperation(surface: OutputSurface, value: unknown): value is OutputOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const operation = value as Record<string, unknown>;
  if (surface === "chat") return exactKeys(operation, ["kind", "chatId", "content", "authorName"])
    && operation.kind === "chat" && typeof operation.chatId === "string" && /^(wc-\d+|[0-9a-f]{16,})$/.test(operation.chatId)
    && typeof operation.content === "string" && operation.content.trim() !== "" && typeof operation.authorName === "string";
  if (!exactKeys(operation, ["kind", "path", "body", "convId", "content"]) || operation.kind !== "sms"
    || (operation.path !== "/api/send-message" && operation.path !== "/api/send-group-message")
    || typeof operation.convId !== "string" || typeof operation.content !== "string"
    || !operation.body || typeof operation.body !== "object" || Array.isArray(operation.body)) return false;
  const body = operation.body as Record<string, unknown>;
  if (operation.path === "/api/send-group-message") return exactKeys(body, ["from_number", "group_id", "content"])
    && typeof body.from_number === "string" && typeof body.group_id === "string" && typeof body.content === "string"
    && operation.convId === `group:${body.group_id}` && operation.content === body.content;
  const keys = Object.keys(body);
  return keys.every(key => key === "from_number" || key === "number" || key === "content" || key === "media_url")
    && typeof body.from_number === "string" && typeof body.number === "string" && operation.convId === body.number
    && ((typeof body.content === "string" && operation.content === body.content && body.media_url === undefined)
      || (typeof body.media_url === "string" && body.content === undefined && operation.content === "[contact card]"));
}
function baseDir(surface: OutputSurface): string {
  return surface === "sms"
    ? process.env.SMS_DELIVERY_RECEIPTS_DIR_OVERRIDE || SMS_DELIVERY_RECEIPTS_DIR
    : process.env.CHAT_OUTPUT_RECEIPTS_DIR_OVERRIDE || CHAT_OUTPUT_RECEIPTS_DIR;
}
export function outputWorkId(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.BAXTER_WORK_ID;
  if (!value) return null;
  if (!validWorkId(value)) throw new Error("invalid BAXTER_WORK_ID");
  return value;
}
export function outputOperationId(operation: OutputOperation): string {
  return createHash("sha256").update(canonical(operation)).digest("hex");
}
function fileFor(surface: OutputSurface, workId: string, operationId: string): string {
  if (!validWorkId(workId) || !/^[a-f0-9]{64}$/.test(operationId)) throw new Error("invalid output receipt identity");
  return join(baseDir(surface), `${workId}-${operationId}.json`);
}
function durableWrite(path: string, receipt: OutputReceipt): void {
  const directory = baseDir(receipt.surface);
  ensureDurableDirectory(directory);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(tmp, path);
    syncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}
function ensureLockTarget(path: string, surface: OutputSurface): void {
  ensureDurableDirectory(baseDir(surface));
  let fd: number | undefined;
  try {
    fd = openSync(`${path}.lock-target`, "wx", 0o600);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    syncDirectory(baseDir(surface));
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
function readFile(surface: OutputSurface, workId: string, operationId: string): OutputReceipt | null {
  try {
    const receipt = JSON.parse(readFileSync(fileFor(surface, workId, operationId), "utf8")) as OutputReceipt;
    if (receipt.version !== 1 || receipt.surface !== surface || receipt.workId !== workId || receipt.operationId !== operationId
      || receipt.idempotencyKey !== `baxter-${createHash("sha256").update(`${workId}:${operationId}`).digest("hex")}`
      || (receipt.state !== "prepared" && receipt.state !== "provider-accepted" && receipt.state !== "completed")
      || !validOperation(surface, receipt.operation) || outputOperationId(receipt.operation) !== operationId
      || typeof receipt.preparedAt !== "string"
      || (surface === "sms" && receipt.state !== "prepared" && (typeof receipt.providerId !== "string" || typeof receipt.acceptedAt !== "string"))
      || (receipt.state === "completed" && typeof receipt.completedAt !== "string")) throw new Error("invalid output receipt");
    if (surface === "sms" && receipt.operation.kind !== "sms") throw new Error("invalid sms output receipt");
    if (surface === "chat" && receipt.operation.kind !== "chat") throw new Error("invalid chat output receipt");
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function withReceipt<T>(surface: OutputSurface, workId: string, operation: OutputOperation, fn: (current: OutputReceipt | null, path: string, operationId: string) => T | Promise<T>): Promise<T> {
  if (!validWorkId(workId)) throw new Error("invalid BAXTER_WORK_ID");
  const operationId = outputOperationId(operation);
  const path = fileFor(surface, workId, operationId);
  ensureLockTarget(path, surface);
  const release = await lockfile.lock(`${path}.lock-target`, { realpath: false, stale: 10_000, retries: { retries: 30, minTimeout: 30, maxTimeout: 300 } });
  try { return await fn(readFile(surface, workId, operationId), path, operationId); }
  finally { await release(); }
}

export async function prepareOutput(surface: OutputSurface, workId: string, operation: OutputOperation): Promise<OutputReceipt> {
  if (!validOperation(surface, operation)) throw new Error(`invalid ${surface} output operation`);
  return withReceipt(surface, workId, operation, current => {
    if (current) return current;
    const operationId = outputOperationId(operation);
    const receipt: OutputReceipt = {
      version: 1, surface, workId, operationId,
      idempotencyKey: `baxter-${createHash("sha256").update(`${workId}:${operationId}`).digest("hex")}`,
      operation, state: "prepared", preparedAt: new Date().toISOString(),
    };
    durableWrite(fileFor(surface, workId, operationId), receipt);
    return receipt;
  });
}
export async function acceptSmsOutput(workId: string, operation: SmsOutputOperation, providerId: string, providerResponse: unknown): Promise<OutputReceipt> {
  if (!providerId) throw new Error("SMS provider acceptance is missing an id");
  return withReceipt("sms", workId, operation, (current, path) => {
    if (!current) throw new Error("SMS output preparation is missing");
    if (current.state !== "prepared") return current;
    const next: OutputReceipt = { ...current, state: "provider-accepted", providerId, providerResponse, acceptedAt: new Date().toISOString() };
    durableWrite(path, next); return next;
  });
}
export async function completeOutput(surface: OutputSurface, workId: string, operation: OutputOperation): Promise<OutputReceipt> {
  return withReceipt(surface, workId, operation, (current, path) => {
    if (!current) throw new Error("output preparation is missing");
    if (current.state === "completed") return current;
    if (surface === "sms" && current.state !== "provider-accepted") throw new Error("SMS output has no provider acceptance");
    const next: OutputReceipt = { ...current, state: "completed", completedAt: new Date().toISOString() };
    durableWrite(path, next); return next;
  });
}
export function outputReceiptsForWork(surface: OutputSurface, workId: string): OutputReceipt[] {
  if (!validWorkId(workId)) throw new Error("invalid BAXTER_WORK_ID");
  let names: string[];
  try { names = readdirSync(baseDir(surface)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return names.filter(name => name.startsWith(`${workId}-`) && name.endsWith(".json"))
    .map(name => readFile(surface, workId, name.slice(workId.length + 1, -5))!)
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
}
export function completedProviderReceipts(surface: OutputSurface, workId: string): Array<{ idempotencyKey: string; providerId: string }> {
  const receipts = outputReceiptsForWork(surface, workId);
  if (receipts.some(receipt => receipt.state !== "completed")) throw new Error(`${surface} output is not reconciled`);
  return receipts.map(receipt => ({ idempotencyKey: receipt.idempotencyKey, providerId: receipt.providerId ?? receipt.operationId }));
}
