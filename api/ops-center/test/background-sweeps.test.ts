// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * services/background-sweeps.ts — ops-center's sweep registry (the on-call
 * rota gauge, the alert delivery health gauges + status retention and the
 * soft-delete retention purge moved here from platform's): which apply, locked
 * vs every replica, and that one broken sweep can't keep the rest from starting.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const lockedCalls: Array<{ name: string; lockKey: string }> = [];
const fakeScheduler = () => ({ start: jest.fn<AnyFn>(), stop: jest.fn<AnyFn>() });
const mockCreateScheduler = jest.fn<AnyFn>(() => fakeScheduler());
let apiToken: string | undefined = 'pd-token';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createScheduler: (...a: unknown[]) => mockCreateScheduler(...a),
  onCallInboundConfig: () => ({ apiToken }),
  leaderLockKey: (svc: string, name: string) => `${svc}:leader:${name}`,
}));
let failBuild: string | undefined;
jest.unstable_mockModule('../src/utils/leader-lock.js', () => ({
  createLockedSweep: (o: { name: string; lockKey: string }) => {
    if (o.name === failBuild) throw new Error('bad config');
    lockedCalls.push(o);
    return fakeScheduler();
  },
}));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ oncall: { rotaIntervalMs: 60_000 } }));
const mockPublishRota = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/services/oncall-rota.js', () => ({ publishRotaCoverage: () => mockPublishRota() }));
const def = (name: string, lockKey?: string) => () => ({ name, ...(lockKey ? { lockKey } : {}), intervalMs: 1000, run: async () => undefined });
jest.unstable_mockModule('../src/services/alert-delivery-status.js', () => ({
  deliveryHealthSweep: def('alert-delivery-health'),
  deliveryStatusRetentionSweep: def('alert-delivery-status-retention', 'ops-center:leader:retention'),
}));
let softDeleteScheduler: unknown = fakeScheduler();
jest.unstable_mockModule('../src/services/soft-delete-purge.js', () => ({
  softDeletePurgeSweep: { name: 'soft-delete-purge', create: () => softDeleteScheduler },
}));

const { sweepDefinitions, registerBackgroundSweeps } = await import('../src/services/background-sweeps.js');

beforeEach(() => {
  jest.clearAllMocks();
  lockedCalls.length = 0;
  apiToken = 'pd-token';
  softDeleteScheduler = fakeScheduler();
  failBuild = undefined;
});

describe('sweepDefinitions', () => {
  it('lists every sweep when everything is configured', async () => {
    expect((await sweepDefinitions()).map((d) => d.name)).toEqual([
      'oncall-rota-coverage', 'alert-delivery-health', 'alert-delivery-status-retention', 'soft-delete-purge',
    ]);
  });

  it('drops the rota gauge without the PagerDuty REST token (never inferred from the routing key)', async () => {
    apiToken = undefined;
    expect((await sweepDefinitions()).map((d) => d.name)).not.toContain('oncall-rota-coverage');
  });

  it('the rota sweep is leader-locked under ops-center and publishes the gauge', async () => {
    const rota = (await sweepDefinitions()).find((d) => d.name === 'oncall-rota-coverage') as { lockKey: string; run: (r: { signal: AbortSignal }) => Promise<void> };
    expect(rota.lockKey).toBe('ops-center:leader:oncall-rota-coverage');
    await rota.run({ signal: new AbortController().signal });
    expect(mockPublishRota).toHaveBeenCalledTimes(1);
  });
});

describe('registerBackgroundSweeps', () => {
  it('starts every applicable sweep and returns them for shutdown', async () => {
    const started = await registerBackgroundSweeps();
    expect(started).toHaveLength(4);
    for (const s of started) expect((s as unknown as { start: jest.Mock }).start).toHaveBeenCalledTimes(1);
    expect(lockedCalls.map((c) => c.name)).toEqual(['oncall-rota-coverage', 'alert-delivery-status-retention']);
    expect(mockCreateScheduler).toHaveBeenCalledWith(expect.objectContaining({ name: 'alert-delivery-health' }));
  });

  it('skips a disabled custom sweep and survives one that fails to build', async () => {
    softDeleteScheduler = null;
    failBuild = 'oncall-rota-coverage';
    const started = await registerBackgroundSweeps();
    expect(started).toHaveLength(2);
  });
});
