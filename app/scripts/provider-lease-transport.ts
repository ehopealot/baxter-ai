// Final provider boundary.  Every outbound request gets a single-use permit
// immediately before fetch and validates the lease again before its response can
// reach the caller.  The concrete control transport is intentionally Task 6.
import { workerControlFromEnv, type WorkerBinding, type WorkerControlClient } from "./worker-control.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export class LeaseRevokedError extends Error { constructor(message = "worker lease revoked") { super(message); this.name = "LeaseRevokedError"; } }

let envTransport: ProviderLeaseTransport | undefined;
export function providerFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (!envTransport) {
    const control = workerControlFromEnv();
    envTransport = new ProviderLeaseTransport(control.client, control.binding, fetch);
  }
  return envTransport.fetch(input, init);
}

export class ProviderLeaseTransport {
  private controllers = new Set<AbortController>();
  private revoked = false;
  private readonly control: WorkerControlClient;
  private readonly binding: WorkerBinding | null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  constructor(control: WorkerControlClient, binding: WorkerBinding | null, fetchImpl: FetchLike = fetch, now: () => number = Date.now) {
    this.control = control; this.binding = binding; this.fetchImpl = fetchImpl; this.now = now;
  }
  async hello(): Promise<void> { if (this.binding) await this.control.hello(this.binding); }
  revoke(): void { this.revoked = true; for (const controller of this.controllers) controller.abort(new LeaseRevokedError()); }
  async fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    if (this.revoked) throw new LeaseRevokedError();
    const permit = this.binding ? await this.control.providerCallPermit(this.binding) : { permit: "resident", leaseGeneration: "resident", expiresAt: Number.MAX_SAFE_INTEGER };
    if (!permit.permit || !Number.isFinite(permit.expiresAt) || permit.expiresAt <= this.now()
      || (this.binding && permit.leaseGeneration !== this.binding.leaseGeneration)) {
      this.revoke(); throw new LeaseRevokedError("worker control refused provider permit");
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    try {
      // The permit authorizes this local boundary; it is never provider data and
      // must not cross the network as an application header. Strip even a stale
      // caller-supplied copy, including one carried by a Request object.
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.delete("x-baxter-provider-permit");
      const response = await this.fetchImpl(input, { ...init, signal, headers });
      if (this.revoked || permit.expiresAt <= this.now()
        || (this.binding && permit.leaseGeneration !== this.binding.leaseGeneration)) {
        this.revoke(); throw new LeaseRevokedError();
      }
      if (this.binding) await this.control.renew(this.binding);
      if (this.revoked || permit.expiresAt <= this.now()) { this.revoke(); throw new LeaseRevokedError(); }
      return response;
    } finally { this.controllers.delete(controller); }
  }
}
