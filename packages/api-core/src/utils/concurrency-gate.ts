// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A FIFO bound on how many things run at once in ONE process.
 *
 * WHY IT IS SHARED. Two services need the same bound for the same reason: a
 * resource they own is consumed by work several producers queue, and the
 * producers' count is set elsewhere. The image registry signs images (each
 * attest hands cosign a 7-17 MiB SBOM against a 1 GiB container), and a plugin
 * replica runs builds (its six per-tier workers share ONE buildkitd sidecar).
 * Both learned it the same way: 32 concurrent signs OOMKilled the registry and
 * took every push with it, because `/token` is the registry login.
 *
 * The queue hand-off below has one subtlety worth having a single copy of:
 * `release` passes the slot straight to the next waiter instead of decrementing
 * first, because a dip to `limit - 1` would admit an extra caller past the
 * ceiling. That is the kind of off-by-one that a second implementation gets
 * wrong silently.
 *
 * WAITING, NOT REFUSING. Over the limit a caller queues; nothing here refuses or
 * times out. Refusing turns a capacity limit into a failure of the work, which
 * is a mistake this codebase has already paid for once (a per-org build slot
 * that failed terminally after a 30-minute wait lost 80 of 119 plugins). The
 * caller's own deadline is what bounds the wait.
 */

export interface ConcurrencyGateOptions {
  /** Read per call, so an env- or config-driven limit can change without a restart. */
  limit: () => number;
  /** Called when a caller has to wait, before it does. */
  onQueued?: (waiting: number, limit: number) => void;
  /** Called whenever occupancy changes, for a gauge. */
  onOccupancy?: (inFlight: number) => void;
}

export interface ConcurrencyGate {
  /** Run `fn` holding a slot. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Current occupancy — for metrics and tests. */
  state(): { inFlight: number; waiting: number };
  /** Test seam: drop a queue left behind by a failed assertion. */
  reset(): void;
}

export function createConcurrencyGate(opts: ConcurrencyGateOptions): ConcurrencyGate {
  let inFlight = 0;
  const waiting: Array<() => void> = [];

  const occupancy = (): void => opts.onOccupancy?.(inFlight);

  function release(): void {
    const next = waiting.shift();
    if (next) {
      // Straight hand-off: see the note above about never dipping below the
      // ceiling between a release and the next admission.
      next();
      return;
    }
    inFlight -= 1;
    occupancy();
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const limit = opts.limit();
      if (inFlight >= limit) {
        opts.onQueued?.(waiting.length + 1, limit);
        await new Promise<void>((resolve) => { waiting.push(resolve); });
      } else {
        inFlight += 1;
      }
      occupancy();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    state: () => ({ inFlight, waiting: waiting.length }),
    reset: () => { inFlight = 0; waiting.length = 0; },
  };
}

// ---------------------------------------------------------------------------
// Keyed variant: one ceiling, per-key floors, and borrowing
// ---------------------------------------------------------------------------

/** Occupancy a {@link KeyedConcurrencyGateOptions.admits} predicate decides on. */
export interface KeyedOccupancy<K> {
  /** Slots in use across every key. */
  total: number;
  /** Slots in use per key. Keys at zero may be absent. */
  perKey: ReadonlyMap<K, number>;
}

export interface KeyedConcurrencyGateOptions<K> {
  /** The TOTAL ceiling, read per call. No key may push occupancy past it. */
  limit: () => number;
  /**
   * May a caller for `key` start right now?
   *
   * Called only when the total ceiling has room, so this expresses the per-key
   * policy alone — a guaranteed floor, a cap, a borrowing allowance. It must be
   * a pure function of the occupancy it is handed: it is re-evaluated on every
   * release, and a predicate that consults anything else (a clock, a counter it
   * mutates) makes admission order unreproducible.
   */
  admits: (key: K, occupancy: KeyedOccupancy<K>) => boolean;
  onQueued?: (key: K, waiting: number, limit: number) => void;
  onOccupancy?: (occupancy: KeyedOccupancy<K>) => void;
}

export interface KeyedConcurrencyGate<K> {
  run<T>(key: K, fn: () => Promise<T>): Promise<T>;
  state(): { inFlight: number; waiting: number; perKey: ReadonlyMap<K, number> };
  reset(): void;
}

/**
 * A FIFO bound with a TOTAL ceiling plus a per-key admission policy.
 *
 * WHY A SECOND SHAPE instead of nesting two of the gates above. Stacking a
 * per-key gate inside the total gate DEADLOCKS: a caller holding a total slot
 * while it waits for a key slot can hold every total slot, and nothing will
 * ever release one. Admission has to be ONE decision, which is what this is.
 *
 * THE HAND-OFF DIFFERS FROM THE COUNT GATE ABOVE, deliberately. There, release
 * passes the slot straight to the head of the queue, because for a pure count
 * any waiter is admissible. Here the head may NOT be — it could be a caller
 * whose key is over its floor while the borrowing allowance is full. So release
 * decrements first and then scans the queue for the first waiter the predicate
 * now admits. Occupancy may therefore dip below the ceiling while callers wait,
 * which is correct: those callers are not admissible, and admitting them anyway
 * is exactly the bound this exists to enforce.
 *
 * ORDER. Relative order is preserved among waiters the predicate admits, so
 * callers sharing a key are strictly FIFO. Across keys it is not: a waiter that
 * cannot start is skipped rather than blocking the queue behind it, which is the
 * point — a blocked borrower must not stall a caller that is within its floor.
 */
export function createKeyedConcurrencyGate<K>(opts: KeyedConcurrencyGateOptions<K>): KeyedConcurrencyGate<K> {
  let total = 0;
  const perKey = new Map<K, number>();
  const waiting: Array<{ key: K; admit: () => void }> = [];

  const snapshot = (): KeyedOccupancy<K> => ({ total, perKey });
  const occupancy = (): void => opts.onOccupancy?.(snapshot());

  const bump = (key: K, by: number): void => {
    const next = (perKey.get(key) ?? 0) + by;
    if (next <= 0) perKey.delete(key); else perKey.set(key, next);
    total += by;
  };

  const admissible = (key: K): boolean => total < opts.limit() && opts.admits(key, snapshot());

  function release(key: K): void {
    bump(key, -1);
    // Scan in arrival order for the first waiter that may now start. Not the
    // blind hand-off of the count gate — see the note above.
    const index = waiting.findIndex((w) => admissible(w.key));
    if (index !== -1) {
      const [next] = waiting.splice(index, 1);
      bump(next.key, 1);
      next.admit();
    }
    occupancy();
  }

  return {
    async run<T>(key: K, fn: () => Promise<T>): Promise<T> {
      if (admissible(key)) {
        bump(key, 1);
      } else {
        opts.onQueued?.(key, waiting.length + 1, opts.limit());
        await new Promise<void>((resolve) => { waiting.push({ key, admit: resolve }); });
      }
      occupancy();
      try {
        return await fn();
      } finally {
        release(key);
      }
    },
    state: () => ({ inFlight: total, waiting: waiting.length, perKey }),
    reset: () => { total = 0; perKey.clear(); waiting.length = 0; },
  };
}
