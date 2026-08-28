// Finite-work accounting for the light process.  Timers/watchers are intake
// sources, not work: callers close them separately and retain the task returned
// by admit() until all of its async descendants settle.
export type LifecycleSnapshot = Readonly<Record<string, number>>;

interface LifecycleSource {
  close: () => void;
  reopen?: () => void;
  active: boolean;
}

export class LightLifecycle {
  #closed = false;
  #work = new Map<string, number>();
  #sources = new Map<string, Set<LifecycleSource>>();
  #resources = new Map<string, Set<() => void>>();
  #changed: (() => void)[] = [];

  get intakeClosed(): boolean { return this.#closed; }
  get idle(): boolean { return [...this.#work.values()].every((n) => n === 0); }
  snapshot(): LifecycleSnapshot { return Object.fromEntries(this.#work); }
  sourceSnapshot(): LifecycleSnapshot {
    return Object.fromEntries([
      ...[...this.#sources].map(([name, sources]) => [name, sources.size] as const),
      ...[...this.#resources].map(([name, closers]) => [name, closers.size] as const),
    ]);
  }
  onChange(listener: () => void): () => void { this.#changed.push(listener); return () => { this.#changed = this.#changed.filter((x) => x !== listener); }; }
  closeIntake(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Quiesce real intake before waiting for admitted descendants. A link or watch
    // left live here could accept work after the drain's idle observation.
    for (const sources of this.#sources.values()) for (const source of sources) {
      if (!source.active) continue;
      try { source.close(); } catch { /* source teardown is best effort */ }
      source.active = false;
    }
    this.#emit();
  }

  /** Stop all process handles after worker control permits final exit. */
  closeSources(): void {
    for (const sources of this.#sources.values()) for (const source of sources) {
      if (!source.active) continue;
      try { source.close(); } catch { /* source teardown is best effort */ }
      source.active = false;
    }
    for (const closers of this.#resources.values()) for (const close of closers) {
      try { close(); } catch { /* final resource teardown is best effort */ }
    }
    this.#sources.clear();
    this.#resources.clear();
  }

  /**
   * Register live intake. closeIntake invokes close; a denied final exit invokes
   * reopen before intake is exposed again. Sources without a reopen callback are
   * one-shot wakeups (for example the heartbeat sleep timer).
   */
  source(name: string, close: () => void, reopen?: () => void): (() => void) | null {
    const source: LifecycleSource = { close, reopen, active: !this.#closed };
    if (this.#closed) {
      try { close(); } catch { /* source was created during shutdown; quiesce best effort */ }
    }
    const sources = this.#sources.get(name) ?? new Set<LifecycleSource>();
    sources.add(source); this.#sources.set(name, sources);
    return () => {
      sources.delete(source);
      if (sources.size === 0) this.#sources.delete(name);
    };
  }

  /** A descendant scheduler/resource that runs through drain and closes only on exit. */
  resource(name: string, close: () => void): (() => void) {
    const closers = this.#resources.get(name) ?? new Set<() => void>();
    closers.add(close); this.#resources.set(name, closers);
    return () => {
      closers.delete(close);
      if (closers.size === 0) this.#resources.delete(name);
    };
  }

  reopenIntake(): void {
    if (!this.#closed) return;
    // Re-establish sources before allowing admission. A wake cannot enter a
    // half-reopened process whose sockets or watches are still closed.
    for (const sources of this.#sources.values()) for (const source of sources) {
      if (source.active || !source.reopen) continue;
      try { source.reopen(); source.active = true; } catch { /* retry on a later reopen */ }
    }
    this.#closed = false;
    this.#emit();
  }

  // An admitted task is deliberately not cancellable. Its release closure is
  // idempotent so error paths can safely share it with finally blocks.
  admit(name: string): (() => void) | null {
    if (this.#closed) return null;
    return this.retain(name);
  }

  /**
   * Extend ownership from work admitted before close. This is intentionally
   * unconditional and is only for asynchronous descendants/durable records;
   * intake callbacks must use admit() so genuinely new work is refused.
   */
  retain(name: string): () => void {
    this.#work.set(name, (this.#work.get(name) ?? 0) + 1);
    this.#emit();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.#work.get(name) ?? 1) - 1;
      if (next <= 0) this.#work.delete(name); else this.#work.set(name, next);
      this.#emit();
    };
  }

  async track<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const release = this.admit(name);
    if (!release) throw new Error(`light intake is closed (${name})`);
    try { return await fn(); } finally { release(); }
  }

  async waitForOpen(): Promise<void> {
    if (!this.#closed) return;
    await new Promise<void>((resolve) => {
      const stop = this.onChange(() => { if (!this.#closed) { stop(); resolve(); } });
    });
  }

  async drain(): Promise<void> {
    if (this.idle) return;
    await new Promise<void>((resolve) => {
      const stop = this.onChange(() => { if (this.idle) { stop(); resolve(); } });
    });
  }
  #emit(): void { for (const listener of this.#changed) listener(); }
}
