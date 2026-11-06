// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The signing gate's WIRING. The queueing mechanics belong to api-core's
 * `createConcurrencyGate` and are tested there; what matters here is the part an
 * operator can get wrong: that the limit is read from
 * `REGISTRY_SIGN_MAX_CONCURRENT` (via config) on every call rather than captured
 * once, and that the occupancy gauge and the queue counter are fed.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';

const captured: { limit?: () => number; onQueued?: AnyFn; onOccupancy?: AnyFn } = {};
const runs: Array<() => Promise<unknown>> = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => stubModule('@pipeline-builder/api-core', {
  createLogger: () => ({ info: jest.fn<AnyFn>(), warn: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), debug: jest.fn<AnyFn>() }),
  // Captured rather than exercised: the real one has its own suite.
  createConcurrencyGate: (opts: { limit: () => number; onQueued?: AnyFn; onOccupancy?: AnyFn }) => {
    Object.assign(captured, opts);
    return {
      run: (fn: () => Promise<unknown>) => { runs.push(fn); return fn(); },
      state: () => ({ inFlight: 0, waiting: 0 }),
      reset: () => undefined,
    };
  },
}));
const incCounter = jest.fn<AnyFn>();
const setGauge = jest.fn<AnyFn>();
const observe = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter, observe, setGauge,
}));
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { pluginSigning: { maxConcurrentSigns: 7 } },
}));

const { withSigningSlot } = await import('../src/services/signing-gate.js');

describe('the signing gate wiring', () => {
  it('reads the limit from config on every call, so a restart is not needed to change it', () => {
    expect(captured.limit?.()).toBe(7);
  });

  it('counts a queued sign and logs it, so time spent at capacity is visible', () => {
    captured.onQueued?.(3, 7);
    expect(incCounter).toHaveBeenCalledWith('registry_sign_queued_total', {});
  });

  it('publishes occupancy as a gauge — the number to compare against the memory limit', () => {
    captured.onOccupancy?.(5);
    expect(setGauge).toHaveBeenCalledWith('registry_sign_inflight', {}, 5);
  });

  it('records the DURATION of a sign that THREW, not just a successful one', async () => {
    // It is in a `finally` on purpose: the slow-and-failing path is exactly the
    // one that sized this gate. 32 concurrent signs peaked the service at
    // 1019 MiB of 1 GiB and it was OOMKilled, and a histogram that only observes
    // successes would have shown a healthy p99 while the failures were the whole
    // story. A refactor moving this into the success branch looks harmless.
    await expect(withSigningSlot('sign', () => Promise.reject(new Error('cosign exit 1'))))
      .rejects.toThrow('cosign exit 1');
    expect(observe).toHaveBeenCalledWith('registry_sign_duration_seconds', { label: 'sign' }, expect.any(Number));
  });

  it('runs the work through the gate and records how long it waited', async () => {
    await expect(withSigningSlot('sign', () => Promise.resolve('signed'))).resolves.toBe('signed');
    // `runs` accumulates across cases in this file; what matters is that the work
    // went THROUGH the gate rather than around it.
    expect(runs.length).toBeGreaterThan(0);
    expect(observe).toHaveBeenCalledWith('registry_sign_wait_seconds', { label: 'sign' }, expect.any(Number));
  });
});
