// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `../src/utils/leader-lock.js` mock for sweep suites: the lock always "wins"
 * (runs the body), and `createLockedSweep` is the REAL api-core scheduler over
 * that body — so interval, start-once and same-pod re-entrancy behavior are
 * exercised for real.
 */
import { jest } from '@jest/globals';

const { createScheduler } = jest.requireActual('@pipeline-builder/api-core') as {
  createScheduler: (o: { name: string; intervalMs: number; runOnStart?: boolean; run: () => Promise<void> }) => unknown;
};

export function leaderLockMock(): Record<string, unknown> {
  return {
    runWithLeaderLock: (_key: string, _ttlMs: number, fn: () => Promise<void>) => fn().then(() => true),
    createLockedSweep: (o: { name: string; intervalMs: number; runOnStart?: boolean; run: () => Promise<void> }) =>
      createScheduler({ name: o.name, intervalMs: o.intervalMs, runOnStart: o.runOnStart, run: o.run }),
  };
}
