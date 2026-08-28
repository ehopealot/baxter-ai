// Core deliberately owns only this typed boundary.  Task 6 supplies the Unix
// socket/token adapter; inventing a wire protocol here would couple core to runner
// lifecycle ownership.  Worker mode fails closed until that adapter is installed.
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

export interface WorkerControlClient {
  hello(binding: WorkerBinding): Promise<void>;
  renew(binding: WorkerBinding): Promise<void>;
  providerCallPermit(binding: WorkerBinding): Promise<ProviderCallPermit>;
  coverage(binding: WorkerBinding, coverage: Coverage): Promise<void>;
  exitPermitted(binding: WorkerBinding): Promise<ExitPermission>;
  drain(binding: WorkerBinding): Promise<void>;
}

export class ResidentWorkerControlClient implements WorkerControlClient {
  async hello(_binding: WorkerBinding): Promise<void> {}
  async renew(_binding: WorkerBinding): Promise<void> {}
  async providerCallPermit(binding: WorkerBinding): Promise<ProviderCallPermit> {
    return { permit: "resident", leaseGeneration: binding.leaseGeneration, expiresAt: Number.MAX_SAFE_INTEGER };
  }
  async coverage(_binding: WorkerBinding, _coverage: Coverage): Promise<void> {}
  async exitPermitted(_binding: WorkerBinding): Promise<ExitPermission> { return { permitted: true }; }
  async drain(_binding: WorkerBinding): Promise<void> {}
}

let installedClient: WorkerControlClient | undefined;
/** Task-6's process entrypoint installs its authenticated socket adapter here. */
export function installWorkerControlClient(client: WorkerControlClient | undefined): void { installedClient = client; }

function bindingFromEnv(env: NodeJS.ProcessEnv): WorkerBinding | null {
  const socketRequested = Boolean(env.BAXTER_WORKER_CONTROL_SOCKET || env.BAXTER_WORKER_MODE === "1");
  if (!socketRequested) return null;
  const tenantId = env.BAXTER_TENANT_ID;
  const containerId = env.BAXTER_CONTAINER_ID;
  const leaseGeneration = env.BAXTER_LEASE_GENERATION;
  const policyGeneration = Number(env.BAXTER_POLICY_GENERATION);
  const policyDigest = env.BAXTER_POLICY_DIGEST;
  const launchFingerprint = env.BAXTER_LAUNCH_FINGERPRINT;
  if (!tenantId || !containerId || !leaseGeneration || !Number.isSafeInteger(policyGeneration) || policyGeneration < 0 || !policyDigest || !launchFingerprint) {
    throw new Error("worker control binding is incomplete");
  }
  return { tenantId, containerId, leaseGeneration, policyGeneration, policyDigest, launchFingerprint };
}

export function workerControlFromEnv(env: NodeJS.ProcessEnv = process.env): { client: WorkerControlClient; binding: WorkerBinding | null } {
  const binding = bindingFromEnv(env);
  if (!binding) return { client: new ResidentWorkerControlClient(), binding: null };
  if (env.BAXTER_HARNESS === "claude") throw new Error("opaque-provider-harness");
  if (!installedClient) throw new Error("worker-control-adapter-unavailable");
  return { client: installedClient, binding };
}
