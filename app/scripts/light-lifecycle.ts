// Finite-work accounting for the light process.  Timers/watchers are intake
// sources, not work: callers close them separately and retain the task returned
// by admit() until all of its async descendants settle.
export type LifecycleSnapshot = Readonly<Record<string, number>>;

export class LightLifecycle {
  #closed = false;
  #work = new Map<string, number>();
  #changed: (() => void)[] = [];

  get intakeClosed(): boolean { return this.#closed; }
  get idle(): boolean { return [...this.#work.values()].every((n) => n === 0); }
  snapshot(): LifecycleSnapshot { return Object.fromEntries(this.#work); }
  onChange(listener: () => void): () => void { this.#changed.push(listener); return () => { this.#changed = this.#changed.filter((x) => x !== listener); }; }
  closeIntake(): void { this.#closed = true; this.#emit(); }
  reopenIntake(): void { this.#closed = false; this.#emit(); }

  // An admitted task is deliberately not cancellable.  Its release closure is
  // idempotent so error paths can safely share it with finally blocks.
  admit(name: string): (() => void) | null {
    if (this.#closed) return null;
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

  async drain(): Promise<void> {
    if (this.idle) return;
    await new Promise<void>((resolve) => {
      const stop = this.onChange(() => { if (this.idle) { stop(); resolve(); } });
    });
  }
  #emit(): void { for (const listener of this.#changed) listener(); }
}
