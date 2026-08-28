// Final provider boundary.  Every outbound request gets a single-use permit
// immediately before fetch and validates the lease again before its response can
// reach the caller.  The concrete control transport is intentionally Task 6.
import { workerControlFromEnv, type WorkerBinding, type WorkerControlClient } from "./worker-control.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export class LeaseRevokedError extends Error { constructor(message = "worker lease revoked") { super(message); this.name = "LeaseRevokedError"; } }
export function isLeaseRevokedError(error: unknown): error is LeaseRevokedError {
  return error instanceof LeaseRevokedError || (error instanceof Error && error.name === "LeaseRevokedError");
}

let envTransport: ProviderLeaseTransport | undefined;
export function providerFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (!envTransport) {
    const control = workerControlFromEnv();
    envTransport = new ProviderLeaseTransport(control.client, control.binding, fetch);
  }
  return envTransport.fetch(input, init);
}

/** Finish a status-only call without leaving its response body (and permit) live. */
export async function cancelProviderResponse(response: Response): Promise<void> {
  if (response.body) await response.body.cancel("status-only response complete");
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
    if (binding) {
      const signal = control.revocationSignal(binding);
      if (signal.aborted) this.revoke();
      else signal.addEventListener("abort", () => this.revoke(), { once: true });
    }
  }
  async hello(): Promise<void> { if (this.binding) await this.control.hello(this.binding); }
  revoke(): void { this.revoked = true; for (const controller of this.controllers) controller.abort(new LeaseRevokedError()); }

  private assertCurrent(permit: { leaseGeneration: string; expiresAt: number }): void {
    if (this.revoked || permit.expiresAt <= this.now()
      || (this.binding && permit.leaseGeneration !== this.binding.leaseGeneration)) {
      this.revoke();
      throw new LeaseRevokedError();
    }
  }

  /** A consumed/cancelled response is publishable only after one typed final fence. */
  private async finishResponse(permit: { leaseGeneration: string; expiresAt: number }): Promise<void> {
    try {
      this.assertCurrent(permit);
      if (this.binding) await this.control.renew(this.binding);
      this.assertCurrent(permit);
    } catch (error) {
      this.revoke();
      if (isLeaseRevokedError(error)) throw error;
      throw new LeaseRevokedError("worker lease renewal failed after provider response");
    }
  }

  async fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    if (this.revoked) throw new LeaseRevokedError();
    let permit: { permit: string; leaseGeneration: string; expiresAt: number };
    try {
      permit = this.binding
        ? await this.control.providerCallPermit(this.binding)
        : { permit: "resident", leaseGeneration: "resident", expiresAt: Number.MAX_SAFE_INTEGER };
    } catch (error) {
      // The control request may reject only after its concurrent revocation
      // notification has closed this transport. Authority loss wins over that
      // incidental socket/request error.
      if (this.revoked) throw new LeaseRevokedError();
      throw error;
    }
    // Revocation may linearize while permit issuance is awaiting the socket. A
    // late successful reply is not authority to start a provider request.
    if (!permit.permit || !Number.isFinite(permit.expiresAt)) {
      this.revoke(); throw new LeaseRevokedError("worker control refused provider permit");
    }
    this.assertCurrent(permit);
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    let response: Response | undefined;
    try {
      // The permit authorizes this local boundary; it is never provider data and
      // must not cross the network as an application header. Strip even a stale
      // caller-supplied copy, including one carried by a Request object.
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.delete("x-baxter-provider-permit");
      response = await this.fetchImpl(input, { ...init, signal, headers });
      this.assertCurrent(permit);
    } catch (error) {
      // A response may already own a live provider body when the post-response
      // authority check fails. Cancel it before dropping our controller.
      if (response?.body) void response.body.cancel(error).catch(() => { /* preserve the authority error */ });
      this.controllers.delete(controller);
      if (this.revoked) throw new LeaseRevokedError();
      throw error;
    }

    // A Response is only a header handle. Provider output is not published until
    // its body consumer has completed and the same permit has passed a final
    // generation/expiry check plus lease renewal. Clones share this controller and
    // each retain fencing until their own consumer settles.
    if (response.body === null) {
      try {
        await this.finishResponse(permit);
        return response;
      } finally { this.controllers.delete(controller); }
    }

    const consumers = new Set(["arrayBuffer", "blob", "bytes", "formData", "json", "text"]);
    let activeWrappers = 0;
    const wrap = (target: Response): Response => {
      activeWrappers++;
      let settled = false;
      let fencedBody: ReadableStream<Uint8Array> | undefined;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        activeWrappers--;
        if (activeWrappers === 0) this.controllers.delete(controller);
      };
      const abortRace = <T>(operation: Promise<T>): { promise: Promise<T>; cleanup: () => void } => {
        let cleanup = () => {};
        const aborted = new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(this.revoked ? new LeaseRevokedError() : (signal.reason ?? new DOMException("Aborted", "AbortError")));
          if (signal.aborted) onAbort();
          else {
            signal.addEventListener("abort", onAbort, { once: true });
            cleanup = () => signal.removeEventListener("abort", onAbort);
          }
        });
        return { promise: Promise.race([operation, aborted]), cleanup };
      };
      const complete = async <T>(consume: () => Promise<T>): Promise<T> => {
        let raced: { promise: Promise<T>; cleanup: () => void } | undefined;
        try {
          this.assertCurrent(permit);
          raced = abortRace(Promise.resolve().then(consume));
          let outcome: { ok: true; value: T } | { ok: false; error: unknown };
          try {
            outcome = { ok: true, value: await raced.promise };
          } catch (error) {
            outcome = { ok: false, error };
          }
          // A parser/consumer failure still completes permit ownership. Run the
          // final authority fence before exposing it; a fence failure must win.
          await this.finishResponse(permit);
          if (!outcome.ok) throw outcome.error;
          return outcome.value;
        } finally { raced?.cleanup(); settle(); }
      };
      const body = (): ReadableStream<Uint8Array> => {
        if (fencedBody) return fencedBody;
        const reader = target.body!.getReader();
        fencedBody = new ReadableStream<Uint8Array>({
          pull: async stream => {
            let raced: { promise: ReturnType<typeof reader.read>; cleanup: () => void } | undefined;
            try {
              this.assertCurrent(permit);
              raced = abortRace(reader.read());
              let result: Awaited<ReturnType<typeof reader.read>>;
              try {
                result = await raced.promise;
              } catch (error) {
                // Direct stream consumers need the same final-fence and
                // revocation-precedence guarantee as Response helpers.
                await this.finishResponse(permit);
                throw error;
              }
              this.assertCurrent(permit);
              if (!result.done) { stream.enqueue(result.value); return; }
              await this.finishResponse(permit);
              settle(); stream.close();
            } catch (error) {
              settle(); stream.error(this.revoked ? new LeaseRevokedError() : error);
            } finally { raced?.cleanup(); }
          },
          cancel: async reason => {
            let raced: { promise: Promise<void>; cleanup: () => void } | undefined;
            try {
              this.assertCurrent(permit);
              raced = abortRace(reader.cancel(reason));
              let outcome: { ok: true } | { ok: false; error: unknown };
              try {
                await raced.promise;
                outcome = { ok: true };
              } catch (error) {
                outcome = { ok: false, error };
              }
              // Cancellation failures also release permit ownership only after
              // the final fence. If revocation aborted a hung cancellation,
              // finishResponse throws the typed authority error immediately.
              await this.finishResponse(permit);
              if (!outcome.ok) throw outcome.error;
            } catch (error) {
              if (this.revoked) throw new LeaseRevokedError();
              throw error;
            } finally { raced?.cleanup(); settle(); }
          },
        });
        return fencedBody;
      };
      return new Proxy(target, {
        get(original, property) {
          if (property === "body") return body();
          if (property === "clone") return () => wrap(original.clone());
          if (typeof property === "string" && consumers.has(property)) {
            const method = (original as unknown as Record<string, () => Promise<unknown>>)[property];
            if (typeof method === "function") return () => complete(() => method.call(original));
          }
          const value = Reflect.get(original, property, original);
          return typeof value === "function" ? value.bind(original) : value;
        },
      });
    };
    return wrap(response);
  }
}
