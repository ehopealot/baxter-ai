import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { FOLLOW_UP_DELIVERY_LOCK_DIR } from "./paths.ts";

export type CancelStatus = "cancelled" | "send_already_started";

interface DeliveryContext { taskId: string; key: string; sendStarted: boolean; }
interface Waiter { version: 1; created_at: number; status: "pending" | "send_started"; }

const activeDelivery = new AsyncLocalStorage<DeliveryContext>();
const STALE_MS = 5 * 60_000;

function root(): string {
  return process.env.FOLLOW_UP_DELIVERY_LOCK_DIR_OVERRIDE || FOLLOW_UP_DELIVERY_LOCK_DIR;
}

function keyFor(taskId: string): string {
  if (typeof taskId !== "string" || taskId.length < 1 || taskId.length > 200) throw new Error("follow-up task id is invalid");
  return createHash("sha256").update(taskId).digest("hex");
}

function paths(key: string) {
  const dir = root();
  return {
    dir,
    delivery: join(dir, `${key}.delivery`),
    registration: join(dir, `${key}.registration`),
    marker: join(dir, `${key}.send-started.json`),
    waiterPrefix: `${key}.waiter.`,
  };
}

function ensureTarget(path: string): void {
  mkdirSync(root(), { recursive: true, mode: 0o700 });
  try { writeFileSync(path, "", { flag: "wx", mode: 0o600 }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("follow-up lock target is invalid");
}

async function acquire(path: string): Promise<() => Promise<void>> {
  ensureTarget(path);
  return lockfile.lock(path, {
    realpath: false,
    stale: 10_000,
    retries: { retries: 100, minTimeout: 10, maxTimeout: 100 },
  });
}

function atomicJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

function readWaiter(path: string): Waiter {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (err) { throw new Error("follow-up cancellation status is malformed", { cause: err }); }
  const waiter = value as Partial<Waiter>;
  if (!waiter || waiter.version !== 1 || !Number.isFinite(waiter.created_at)
    || (waiter.status !== "pending" && waiter.status !== "send_started")) {
    throw new Error("follow-up cancellation status is malformed");
  }
  return waiter as Waiter;
}

function cleanupStale(p: ReturnType<typeof paths>, now = Date.now()): void {
  for (const name of readdirSync(p.dir)) {
    if (!name.startsWith(p.waiterPrefix) || !name.endsWith(".json")) continue;
    const path = join(p.dir, name);
    try {
      const waiter = readWaiter(path);
      if (now - waiter.created_at > STALE_MS) unlinkSync(path);
    } catch {
      const stat = lstatSync(path);
      if (now - stat.mtimeMs > STALE_MS) unlinkSync(path);
      else throw new Error("follow-up cancellation status is malformed");
    }
  }
  if (existsSync(p.marker)) {
    const stat = lstatSync(p.marker);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("follow-up send status is malformed");
    if (now - stat.mtimeMs > STALE_MS) unlinkSync(p.marker);
  }
}

function waiterPaths(p: ReturnType<typeof paths>): string[] {
  return readdirSync(p.dir)
    .filter((name) => name.startsWith(p.waiterPrefix) && name.endsWith(".json"))
    .map((name) => join(p.dir, name));
}

export function markFollowUpSendStarted(taskId: string): void {
  const current = activeDelivery.getStore();
  const key = keyFor(taskId);
  if (!current || current.key !== key || current.taskId !== taskId) throw new Error("follow-up send is not under its delivery lock");
  current.sendStarted = true;
  atomicJson(paths(key).marker, { version: 1, task_id_hash: key, started_at: Date.now() });
}

export async function withFollowUpDeliveryLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
  const key = keyFor(taskId);
  const p = paths(key);
  const releaseDelivery = await acquire(p.delivery);
  const context: DeliveryContext = { taskId, key, sendStarted: false };
  let value!: T;
  let operationError: unknown;
  try { value = await activeDelivery.run(context, operation); }
  catch (err) { operationError = err; }

  let releaseRegistration: (() => Promise<void>) | undefined;
  let finalizeError: unknown;
  try {
    releaseRegistration = await acquire(p.registration);
    cleanupStale(p);
    if (context.sendStarted) {
      for (const waiterPath of waiterPaths(p)) {
        const waiter = readWaiter(waiterPath);
        atomicJson(waiterPath, { ...waiter, status: "send_started" });
      }
    }
    try { unlinkSync(p.marker); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  } catch (err) { finalizeError = err; }
  finally {
    await releaseDelivery();
    if (releaseRegistration) await releaseRegistration();
  }
  if (operationError !== undefined) throw operationError;
  if (finalizeError !== undefined) throw finalizeError;
  return value;
}

export async function cancelWithFollowUpLinearization(
  id: string,
  remove: () => Promise<boolean>,
): Promise<{ removed: boolean; status: CancelStatus }> {
  const key = keyFor(id);
  const p = paths(key);
  const token = randomBytes(16).toString("hex");
  const waiterPath = join(p.dir, `${p.waiterPrefix}${token}.json`);

  let releaseRegistration = await acquire(p.registration);
  try {
    cleanupStale(p);
    writeFileSync(waiterPath, JSON.stringify({ version: 1, created_at: Date.now(), status: "pending" } satisfies Waiter), { flag: "wx", mode: 0o600 });
  } finally { await releaseRegistration(); }

  const releaseDelivery = await acquire(p.delivery);
  let removed = false;
  let status: CancelStatus = "cancelled";
  let error: unknown;
  try {
    const waiter = readWaiter(waiterPath);
    if (waiter.status === "send_started" || existsSync(p.marker)) status = "send_already_started";
    removed = await remove();
  } catch (err) { error = err; }

  // Cleanup uses the same registration-before-delivery-release ordering as send
  // finalization, closing the gap in which a later send could reuse artifacts.
  releaseRegistration = await acquire(p.registration);
  try {
    try { unlinkSync(waiterPath); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    if (status === "send_already_started") {
      try { unlinkSync(p.marker); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    }
  } catch (err) { if (error === undefined) error = err; }
  finally {
    await releaseDelivery();
    await releaseRegistration();
  }
  if (error !== undefined) throw error;
  return { removed: status === "send_already_started" ? true : removed, status };
}
