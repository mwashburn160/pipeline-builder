// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `../src/utils/leader-lock.js` mock for sweep suites: the lock always "wins"
 * (runs the body), and `createLockedSweep` is the REAL api-core scheduler over
 * that body — so interval, start-once and same-pod re-entrancy behavior are
 * exercised for real.
 */
import { jest } from '@jest/globals';

/** The slice of a leader-locked run a sweep body reads. */
type Run = { signal: AbortSignal };
type SweepOpts = { name: string; intervalMs: number; runOnStart?: boolean; run: (run: Run) => Promise<void> };

const { createScheduler } = jest.requireActual('@pipeline-builder/api-core') as {
  createScheduler: (o: SweepOpts) => unknown;
};

export function leaderLockMock(): Record<string, unknown> {
  return {
    // The body receives a real (never-aborted) run, matching what withLeaderLock
    // hands it — a sweep that reads `run.signal` must not crash under the mock.
    runWithLeaderLock: (_key: string, _ttlMs: number, fn: (run: Run) => Promise<void>) =>
      fn({ signal: new AbortController().signal }).then(() => true),
    createLockedSweep: (o: SweepOpts) =>
      createScheduler({ name: o.name, intervalMs: o.intervalMs, runOnStart: o.runOnStart, run: o.run }),
  };
}
