import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePhone } from "./normalize-phone.ts";
import { isStrictGroupId } from "./sms-transcript.ts";
import { isValidChatId } from "./chat-transcript.ts";
import { FOLLOW_UP_CONTEXT_DIR } from "./paths.ts";

export const FOLLOW_UP_CONTEXT_ENV = "BAXTER_FOLLOWUP_CONTEXT_PATH";

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
  writeFileSync(path, JSON.stringify(context), { flag: "wx", mode: 0o600 });
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
  deps: { uid?: number } = {},
): FollowUpRunContext {
  const path = env[FOLLOW_UP_CONTEXT_ENV];
  if (!path) throw new Error("follow-up context path is missing");
  if (path.length > 4096) throw new Error("follow-up context path is invalid");
  let stat;
  try { stat = lstatSync(path); }
  catch (err) { throw new Error("follow-up context is unavailable", { cause: err }); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("follow-up context must be a regular file");
  const uid = deps.uid ?? processUid();
  if (stat.uid !== uid) throw new Error("follow-up context has the wrong owner");
  if ((stat.mode & 0o777) !== 0o600) throw new Error("follow-up context must have mode 0600");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (err) { throw new Error("follow-up context is malformed", { cause: err }); }
  return validateContext(parsed);
}
