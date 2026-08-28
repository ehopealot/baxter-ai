import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join, resolve } from "node:path";

export interface WorkerBinding {
  tenantId: string;
  containerId: string; // full Engine container ID, never a name/short ID
  leaseGeneration: string;
  policyGeneration: number;
  policyDigest: string;
  launchFingerprint: string;
}
export interface ProviderCallPermit { permit: string; leaseGeneration: string; expiresAt: number; }
export interface Coverage { queue: "mail" | "sms" | "chat" | "home"; highWater: number; }
export interface ExitPermission { permitted: boolean; }

export interface WorkerControlLifecycle {
  hello(): Promise<void>;
  renew(): Promise<void>;
  coverage(coverage: Coverage): Promise<void>;
  exitPermitted(): Promise<boolean>;
  drain(): Promise<void>;
}

export function lifecycleControl(client: WorkerControlClient, binding: WorkerBinding | null): WorkerControlLifecycle {
  return {
    hello: async () => { if (binding) await client.hello(binding); },
    renew: async () => { if (binding) await client.renew(binding); },
    coverage: async (coverage) => { if (binding) await client.coverage(binding, coverage); },
    exitPermitted: async () => !binding || (await client.exitPermitted(binding)).permitted,
    drain: async () => { if (binding) await client.drain(binding); },
  };
}

export interface WorkerControlClient {
  hello(binding: WorkerBinding): Promise<void>;
  renew(binding: WorkerBinding): Promise<void>;
  providerCallPermit(binding: WorkerBinding): Promise<ProviderCallPermit>;
  /** Aborts as soon as the runner revokes this bound lease generation. */
  revocationSignal(binding: WorkerBinding): AbortSignal;
  coverage(binding: WorkerBinding, coverage: Coverage): Promise<void>;
  exitPermitted(binding: WorkerBinding): Promise<ExitPermission>;
  drain(binding: WorkerBinding): Promise<void>;
}

const residentRevocationSignal = new AbortController().signal;
export class ResidentWorkerControlClient implements WorkerControlClient {
  async hello(_binding: WorkerBinding): Promise<void> {}
  async renew(_binding: WorkerBinding): Promise<void> {}
  async providerCallPermit(binding: WorkerBinding): Promise<ProviderCallPermit> {
    return { permit: "resident", leaseGeneration: binding.leaseGeneration, expiresAt: Number.MAX_SAFE_INTEGER };
  }
  revocationSignal(_binding: WorkerBinding): AbortSignal { return residentRevocationSignal; }
  async coverage(_binding: WorkerBinding, _coverage: Coverage): Promise<void> {}
  async exitPermitted(_binding: WorkerBinding): Promise<ExitPermission> { return { permitted: true }; }
  async drain(_binding: WorkerBinding): Promise<void> {}
}

interface MountedWorkerBinding {
  version: 1;
  tenantId: string;
  containerId: string;
  generation: string;
  workerPolicyGeneration: number;
  workerPolicyDigest: string;
  launchFingerprint: string;
}

interface ControlResponse {
  version: 1;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

const BINDING_KEYS = ["version", "tenantId", "containerId", "generation", "workerPolicyGeneration", "workerPolicyDigest", "launchFingerprint"] as const;

function mountedBinding(path: string): WorkerBinding {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("worker control binding metadata is invalid");
  const metadata = value as Record<string, unknown>;
  if (Object.keys(metadata).length !== BINDING_KEYS.length || !BINDING_KEYS.every(key => Object.hasOwn(metadata, key))
    || metadata.version !== 1 || typeof metadata.tenantId !== "string" || metadata.tenantId === "" || metadata.tenantId.length > 128
    || typeof metadata.containerId !== "string" || !/^[a-f0-9]{64}$/.test(metadata.containerId)
    || typeof metadata.generation !== "string" || metadata.generation === "" || metadata.generation.length > 128
    || !Number.isSafeInteger(metadata.workerPolicyGeneration) || (metadata.workerPolicyGeneration as number) < 0
    || typeof metadata.workerPolicyDigest !== "string" || metadata.workerPolicyDigest === "" || metadata.workerPolicyDigest.length > 256
    || typeof metadata.launchFingerprint !== "string" || metadata.launchFingerprint === "" || metadata.launchFingerprint.length > 256) {
    throw new Error("worker control binding metadata is invalid");
  }
  const typed = metadata as unknown as MountedWorkerBinding;
  return {
    tenantId: typed.tenantId,
    containerId: typed.containerId,
    leaseGeneration: typed.generation,
    policyGeneration: typed.workerPolicyGeneration,
    policyDigest: typed.workerPolicyDigest,
    launchFingerprint: typed.launchFingerprint,
  };
}

function wireBinding(binding: WorkerBinding): Record<string, unknown> {
  return {
    tenantId: binding.tenantId,
    containerId: binding.containerId,
    generation: binding.leaseGeneration,
    workerPolicyGeneration: binding.policyGeneration,
    workerPolicyDigest: binding.policyDigest,
    launchFingerprint: binding.launchFingerprint,
  };
}

/**
 * Core's JSONL v1 client for the per-launch runner socket. The runner mounts the
 * directory before Compose create, then publishes worker-binding.json only after
 * it has inspected the stopped candidate's full Engine ID. Consequently neither
 * the image nor pre-create environment needs to predict a container identity.
 */
export class UnixSocketWorkerControlClient implements WorkerControlClient {
  readonly #socketPath: string;
  readonly #token: string;
  readonly #binding: WorkerBinding;
  readonly #revoked = new AbortController();
  readonly #pending = new Map<string, PendingRequest>();
  #socket: Socket | undefined;
  #connecting: Promise<Socket> | undefined;
  #buffer = "";
  #nextRequestId = 0;

  constructor(controlDir: string, binding: WorkerBinding = mountedBinding(join(controlDir, "worker-binding.json"))) {
    const directory = resolve(controlDir);
    this.#socketPath = join(directory, "control.sock");
    this.#binding = binding;
    const token = readFileSync(join(directory, "token"), "utf8");
    if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("worker control token is invalid");
    this.#token = token;
  }

  binding(): WorkerBinding { return { ...this.#binding }; }

  async #connect(): Promise<Socket> {
    if (this.#revoked.signal.aborted) throw new Error("worker control lease is revoked");
    if (this.#socket && !this.#socket.destroyed) return this.#socket;
    if (this.#connecting) return this.#connecting;
    this.#connecting = new Promise<Socket>((resolveConnection, rejectConnection) => {
      const socket = createConnection({ path: this.#socketPath });
      const onInitialError = (error: Error) => rejectConnection(error);
      socket.once("error", onInitialError);
      socket.once("connect", () => {
        socket.off("error", onInitialError);
        this.#socket = socket;
        socket.setEncoding("utf8");
        socket.on("data", chunk => this.#onData(String(chunk)));
        socket.on("error", error => this.#failClosed(error));
        socket.on("close", () => this.#failClosed(new Error("worker control socket closed")));
        socket.unref();
        resolveConnection(socket);
      });
    }).finally(() => { this.#connecting = undefined; });
    return this.#connecting;
  }

  #failClosed(error: Error): void {
    if (!this.#revoked.signal.aborted) this.#revoked.abort(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#socket?.destroy();
    this.#socket = undefined;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > 1024 * 1024) { this.#failClosed(new Error("worker control frame exceeds limit")); return; }
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line) as unknown; }
      catch { this.#failClosed(new Error("worker control returned invalid JSON")); return; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.#failClosed(new Error("worker control returned an invalid frame")); return;
      }
      const frame = parsed as Record<string, unknown>;
      if (frame.version !== 1) { this.#failClosed(new Error("worker control returned an unsupported version")); return; }
      if (frame.type === "revoked") {
        const keys = Object.keys(frame);
        if (keys.length !== 4 || !["version", "type", "generation", "reason"].every(key => Object.hasOwn(frame, key))
          || typeof frame.generation !== "string" || frame.generation === "" || frame.generation.length > 128
          || typeof frame.reason !== "string" || frame.reason === "" || frame.reason.length > 1024) {
          this.#failClosed(new Error("worker control returned an invalid revocation")); return;
        }
        if (frame.generation !== this.#binding.leaseGeneration) continue;
        this.#failClosed(new Error(frame.reason));
        return;
      }
      const response = frame as unknown as ControlResponse;
      if (typeof response.requestId !== "string" || typeof response.ok !== "boolean") {
        this.#failClosed(new Error("worker control returned an invalid response")); return;
      }
      const pending = this.#pending.get(response.requestId);
      if (!pending) continue;
      this.#pending.delete(response.requestId);
      if (this.#pending.size === 0) this.#socket?.unref();
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(typeof response.error === "string" ? response.error : "worker control request refused"));
    }
  }

  async #request(type: "hello" | "renew" | "provider-call-permit" | "coverage" | "drain-now" | "exit-permitted", extra: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#revoked.signal.aborted) throw new Error("worker control lease is revoked");
    const socket = await this.#connect();
    if (this.#revoked.signal.aborted) throw new Error("worker control lease is revoked");
    const requestId = `${process.pid}-${++this.#nextRequestId}`;
    const frame = { version: 1, requestId, type, token: this.#token, ...wireBinding(this.#binding), ...extra };
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      this.#pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest });
      socket.ref();
      socket.write(`${JSON.stringify(frame)}\n`, error => {
        if (!error) return;
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        pending.reject(error);
        this.#failClosed(error);
      });
    });
  }

  #assertBinding(binding: WorkerBinding): void {
    if (JSON.stringify(binding) !== JSON.stringify(this.#binding)) throw new Error("worker control binding mismatch");
  }

  async hello(binding: WorkerBinding): Promise<void> { this.#assertBinding(binding); await this.#request("hello"); }
  async renew(binding: WorkerBinding): Promise<void> { this.#assertBinding(binding); await this.#request("renew"); }
  async providerCallPermit(binding: WorkerBinding): Promise<ProviderCallPermit> {
    this.#assertBinding(binding);
    const result = await this.#request("provider-call-permit") as Record<string, unknown> | undefined;
    if (!result || typeof result.permit !== "string" || result.permit === "" || result.generation !== binding.leaseGeneration
      || typeof result.expiresAt !== "number" || !Number.isFinite(result.expiresAt)) throw new Error("worker control returned an invalid provider permit");
    return { permit: result.permit, leaseGeneration: result.generation as string, expiresAt: result.expiresAt };
  }
  revocationSignal(binding: WorkerBinding): AbortSignal { this.#assertBinding(binding); return this.#revoked.signal; }
  async coverage(binding: WorkerBinding, coverage: Coverage): Promise<void> {
    this.#assertBinding(binding);
    if (!Number.isSafeInteger(coverage.highWater) || coverage.highWater < 0) throw new Error("invalid queue coverage");
    await this.#request("coverage", { coverage });
  }
  async exitPermitted(binding: WorkerBinding): Promise<ExitPermission> {
    this.#assertBinding(binding);
    const result = await this.#request("exit-permitted") as Record<string, unknown> | undefined;
    if (!result || typeof result.permitted !== "boolean") throw new Error("worker control returned invalid exit permission");
    return { permitted: result.permitted };
  }
  async drain(binding: WorkerBinding): Promise<void> { this.#assertBinding(binding); await this.#request("drain-now"); }
}

let installedClient: WorkerControlClient | undefined;
/** A narrow injection seam for tests; production worker mode bootstraps the Unix client. */
export function installWorkerControlClient(client: WorkerControlClient | undefined): void { installedClient = client; }

export function isWorkerModeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.BAXTER_WORKER_CONTROL_DIR || env.BAXTER_WORKER_MODE === "1");
}

export function workerControlFromEnv(env: NodeJS.ProcessEnv = process.env): { client: WorkerControlClient; binding: WorkerBinding | null } {
  if (!isWorkerModeEnv(env)) return { client: new ResidentWorkerControlClient(), binding: null };
  if (env.BAXTER_HARNESS === "claude") throw new Error("opaque-provider-harness");
  const directory = env.BAXTER_WORKER_CONTROL_DIR;
  if (!directory) throw new Error("BAXTER_WORKER_CONTROL_DIR is required in worker mode");
  const binding = mountedBinding(join(directory, "worker-binding.json"));
  const client = installedClient ?? new UnixSocketWorkerControlClient(directory, binding);
  return { client, binding };
}
