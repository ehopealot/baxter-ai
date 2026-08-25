import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePhone } from "./normalize-phone.ts";
import { isStrictGroupId } from "./sms-transcript.ts";
import { isValidChatId } from "./chat-transcript.ts";
import { FOLLOW_UP_CONTEXT_DIR } from "./paths.ts";

export const FOLLOW_UP_CONTEXT_ENV = "BAXTER_FOLLOWUP_CONTEXT_PATH";
export const FOLLOW_UP_CONTEXT_MAX_BYTES = 4096;
export const FOLLOW_UP_CONTEXT_MAX_AGE_MS = 6 * 60 * 60_000;
const FUTURE_SKEW_MS = 60_000;

export type FollowUpRunContext =
  | { version: 1; turn_token: string; surface: "sms"; conversation_id: string; phone: string }
  | { version: 1; turn_token: string; surface: "sms-group"; conversation_id: string; group_id: string }
  | { version: 1; turn_token: string; surface: "mail"; thread_id: string }
  | { version: 1; turn_token: string; surface: "home-chat"; chat_id: string; author_id: string };

export interface FollowUpContextHandle {
  path: string;
  context: FollowUpRunContext;
  dispose(): void;
}

type FollowUpOriginContext =
  | { surface: "sms"; conversation_id: string; phone: string }
  | { surface: "sms-group"; conversation_id: string; group_id: string }
  | { surface: "mail"; thread_id: string }
  | { surface: "home-chat"; chat_id: string; author_id: string };

interface StoredContext {
  version: 1;
  lease: { pid: number; process_start: string; created_at: number };
  context: FollowUpRunContext;
}

function exactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function validateContext(value: unknown): FollowUpRunContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("follow-up context is malformed");
  const context = value as Record<string, unknown>;
  if (context.version !== 1 || typeof context.turn_token !== "string" || !/^[0-9a-f]{64}$/.test(context.turn_token)) {
    throw new Error("follow-up context is malformed");
  }
  const common = { version: 1 as const, turn_token: context.turn_token };
  if (context.surface === "sms") {
    if (!exactKeys(context, ["version", "turn_token", "surface", "conversation_id", "phone"])
      || !isBoundedText(context.phone, 32) || normalizePhone(context.phone) !== context.phone
      || context.conversation_id !== context.phone) throw new Error("follow-up SMS context is malformed");
    return { ...common, surface: "sms", conversation_id: context.phone, phone: context.phone };
  }
  if (context.surface === "sms-group") {
    if (!exactKeys(context, ["version", "turn_token", "surface", "conversation_id", "group_id"])
      || !isBoundedText(context.group_id, 64) || !isStrictGroupId(context.group_id)
      || context.conversation_id !== `group:${context.group_id}`) throw new Error("follow-up SMS group context is malformed");
    return { ...common, surface: "sms-group", conversation_id: `group:${context.group_id}`, group_id: context.group_id };
  }
  if (context.surface === "mail") {
    if (!exactKeys(context, ["version", "turn_token", "surface", "thread_id"])
      || !isBoundedText(context.thread_id, 500) || !/^resend:[^:]+:.+$/.test(context.thread_id)) throw new Error("follow-up mail context is malformed");
    return { ...common, surface: "mail", thread_id: context.thread_id };
  }
  if (context.surface === "home-chat") {
    if (!exactKeys(context, ["version", "turn_token", "surface", "chat_id", "author_id"])
      || !isBoundedText(context.chat_id, 100) || !isValidChatId(context.chat_id)
      || !isBoundedText(context.author_id, 300) || !context.author_id.startsWith("member:")
      || context.author_id === "member:") throw new Error("follow-up Home Chat context is malformed");
    return { ...common, surface: "home-chat", chat_id: context.chat_id, author_id: context.author_id };
  }
  throw new Error("follow-up context surface is unsupported");
}

function processUid(): number {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid)) throw new Error("follow-up context ownership cannot be verified");
  return uid as number;
}

function ensureProtectedDirectory(dir: string, uid: number): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
    throw new Error("follow-up context directory is not protected");
  }
}

/** Linux /proc start ticks (field 22), paired with PID to reject PID reuse. */
function processStartIdentity(pid: number): string {
  let raw: string;
  try { raw = readFileSync(`/proc/${pid}/stat`, "utf8"); }
  catch (err) { throw new Error("follow-up context owner process is not live", { cause: err }); }
  // comm is parenthesized and may contain spaces or ')'; fields after its final
  // ')' begin at field 3 (state), making starttime field 22 index 19 here.
  const close = raw.lastIndexOf(")");
  const fields = close >= 0 ? raw.slice(close + 1).trim().split(/\s+/) : [];
  const start = fields[19];
  if (!start || !/^\d+$/.test(start)) throw new Error("follow-up context owner process identity is unavailable");
  return start;
}

function validateStored(value: unknown, now: number): FollowUpRunContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("follow-up context is malformed");
  const stored = value as Record<string, unknown>;
  if (!exactKeys(stored, ["version", "lease", "context"]) || stored.version !== 1
    || !stored.lease || typeof stored.lease !== "object" || Array.isArray(stored.lease)) {
    throw new Error("follow-up context is malformed");
  }
  const lease = stored.lease as Record<string, unknown>;
  if (!exactKeys(lease, ["pid", "process_start", "created_at"])
    || !Number.isSafeInteger(lease.pid) || (lease.pid as number) < 1
    || typeof lease.process_start !== "string" || !/^\d+$/.test(lease.process_start)
    || !Number.isSafeInteger(lease.created_at)) throw new Error("follow-up context lease is malformed");
  const age = now - (lease.created_at as number);
  if (age > FOLLOW_UP_CONTEXT_MAX_AGE_MS || age < -FUTURE_SKEW_MS) throw new Error("follow-up context lease has expired");
  const actualStart = processStartIdentity(lease.pid as number);
  if (actualStart !== lease.process_start) throw new Error("follow-up context owner process identity changed");
  return validateContext(stored.context);
}

export function createFollowUpRunContext(
  origin: FollowUpOriginContext,
  deps: { dir?: string; token?: () => string } = {},
): FollowUpContextHandle {
  const token = deps.token?.() ?? randomBytes(32).toString("hex");
  const context = validateContext({ version: 1, turn_token: token, ...origin });
  const dir = deps.dir ?? FOLLOW_UP_CONTEXT_DIR;
  const uid = processUid();
  ensureProtectedDirectory(dir, uid);
  const path = join(dir, `${randomBytes(16).toString("hex")}.json`);
  const stored: StoredContext = {
    version: 1,
    lease: { pid: process.pid, process_start: processStartIdentity(process.pid), created_at: Date.now() },
    context,
  };
  const bytes = JSON.stringify(stored);
  if (Buffer.byteLength(bytes) > FOLLOW_UP_CONTEXT_MAX_BYTES) throw new Error("follow-up context is too large");
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  let disposed = false;
  return {
    path,
    context,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { unlinkSync(path); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    },
  };
}

export function loadFollowUpRunContext(
  env: NodeJS.ProcessEnv = process.env,
  deps: { uid?: number; now?: number; afterOpen?: (fd: number) => void } = {},
): FollowUpRunContext {
  const path = env[FOLLOW_UP_CONTEXT_ENV];
  if (!path) throw new Error("follow-up context path is missing");
  if (path.length > 4096) throw new Error("follow-up context path is invalid");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new Error("follow-up context must be a regular file", { cause: err });
    throw new Error("follow-up context is unavailable", { cause: err });
  }
  try {
    deps.afterOpen?.(fd);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("follow-up context must be a regular file");
    const uid = deps.uid ?? processUid();
    if (stat.uid !== uid) throw new Error("follow-up context has the wrong owner");
    if ((stat.mode & 0o777) !== 0o600) throw new Error("follow-up context must have mode 0600");
    if (stat.size > FOLLOW_UP_CONTEXT_MAX_BYTES) throw new Error("follow-up context is too large");
    const buffer = Buffer.alloc(FOLLOW_UP_CONTEXT_MAX_BYTES + 1);
    let total = 0;
    for (;;) {
      const count = readSync(fd, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
      if (total > FOLLOW_UP_CONTEXT_MAX_BYTES || total === buffer.length) throw new Error("follow-up context is too large");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(buffer.subarray(0, total).toString("utf8")); }
    catch (err) { throw new Error("follow-up context is malformed", { cause: err }); }
    return validateStored(parsed, deps.now ?? Date.now());
  } finally { closeSync(fd); }
}
