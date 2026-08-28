// In-process intake gate for drain participants. Durable drain admission lives in
// drain.ts; this valve stops a daemon from beginning new callback work while its
// existing work is allowed to finish.
export type CloseIntake = () => void | Promise<void>;

export interface DrainParticipant {
  close(): Promise<void>;
}

export class DrainValve implements DrainParticipant {
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private readonly closeIntake: CloseIntake;

  constructor(closeIntake: CloseIntake = () => {}) {
    this.closeIntake = closeIntake;
  }

  get isClosed(): boolean { return this.closed; }

  // Invoke a callback only while intake remains open. JS executes this check and
  // callback entry synchronously, so close() cannot slip between them.
  guard<T>(callback: () => T): T | undefined {
    if (this.closed) return undefined;
    return callback();
  }

  // Close intake exactly once. Concurrent/repeated callers observe the same
  // completion (or failure) rather than invoking the participant twice.
  close(): Promise<void> {
    if (this.closePromise === null) {
      this.closed = true;
      this.closePromise = Promise.resolve().then(this.closeIntake);
    }
    return this.closePromise;
  }
}
