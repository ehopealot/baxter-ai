import type { LightLifecycle } from "./light-lifecycle.ts";
import type { Coverage, WorkerControlLifecycle } from "./worker-control.ts";

export type CoverageQueue = Coverage["queue"];

interface QueueState {
  target: number;
  reported: number;
  running: Promise<void> | null;
  retryTimer?: ReturnType<typeof setTimeout>;
  release?: () => void;
}

/**
 * Serializes monotonic coverage by queue. Targets come only from fsynced cursors,
 * remain lifecycle blockers until acknowledged by worker control, and are replayed
 * after control hello or a denied-exit reopen.
 */
export class WorkerCoverageCoordinator {
  private readonly states = new Map<CoverageQueue, QueueState>();
  private wasClosed = false;
  private readonly removeChange: () => void;
  private readonly removeResource: () => void;

  private readonly control: WorkerControlLifecycle;
  private readonly lifecycle: LightLifecycle;
  private readonly logErr: (message: string) => void;
  private readonly retryDelayMs: number;

  constructor(
    control: WorkerControlLifecycle,
    lifecycle: LightLifecycle,
    logErr: (message: string) => void,
    retryDelayMs = 1_000,
  ) {
    this.control = control; this.lifecycle = lifecycle; this.logErr = logErr; this.retryDelayMs = retryDelayMs;
    this.wasClosed = lifecycle.intakeClosed;
    this.removeChange = lifecycle.onChange(() => {
      const closed = lifecycle.intakeClosed;
      const reopened = this.wasClosed && !closed;
      this.wasClosed = closed;
      if (reopened) this.replay();
    });
    this.removeResource = lifecycle.resource("worker-control:coverage-coordinator", () => this.close());
  }

  advance(queue: CoverageQueue, highWater: number): void {
    if (!Number.isSafeInteger(highWater) || highWater < 0) return;
    const state = this.state(queue);
    state.target = Math.max(state.target, highWater);
    if (!state.release) state.release = this.lifecycle.intakeClosed
      ? this.lifecycle.retain(`worker-control:coverage:${queue}`)
      : this.lifecycle.admit(`worker-control:coverage:${queue}`) ?? undefined;
    this.pump(queue, state);
  }

  /** Re-send each queue's durable high-water after hello/reopen. */
  replay(): void {
    for (const [queue, state] of this.states) {
      if (state.target < 0) continue;
      state.reported = -1;
      if (!state.release) state.release = this.lifecycle.intakeClosed
        ? this.lifecycle.retain(`worker-control:coverage:${queue}`)
        : this.lifecycle.admit(`worker-control:coverage:${queue}`) ?? undefined;
      this.pump(queue, state);
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.states.values()].map(state => state.running ?? Promise.resolve()));
  }

  close(): void {
    this.removeChange();
    this.removeResource();
    for (const state of this.states.values()) {
      if (state.retryTimer) clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
      state.release?.(); state.release = undefined;
    }
  }

  private state(queue: CoverageQueue): QueueState {
    let state = this.states.get(queue);
    if (!state) {
      state = { target: -1, reported: -1, running: null };
      this.states.set(queue, state);
    }
    return state;
  }

  private pump(queue: CoverageQueue, state: QueueState): void {
    if (state.running || state.retryTimer || state.reported >= state.target) {
      if (state.reported >= state.target) { state.release?.(); state.release = undefined; }
      return;
    }
    state.running = (async () => {
      while (state.reported < state.target) {
        const highWater = state.target;
        await this.control.coverage({ queue, highWater });
        state.reported = highWater;
      }
      state.release?.(); state.release = undefined;
    })().catch(error => {
      this.logErr(`light: ${queue} coverage failed: ${(error as Error).message}`);
      state.retryTimer = setTimeout(() => {
        state.retryTimer = undefined;
        this.pump(queue, state);
      }, this.retryDelayMs);
      state.retryTimer.unref?.();
    }).finally(() => {
      state.running = null;
      if (!state.retryTimer && state.reported < state.target) this.pump(queue, state);
    });
  }
}
