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
