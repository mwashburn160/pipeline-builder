// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * middleware/quota.ts — feature quotas (dashboards / alertRules /
 * alertDestinations) reserve against the ACCOUNT ROOT, resolved through
 * platform's `orgAccountRoot` contract (platform read its own Mongo hierarchy
 * for this before the split). Pins: reserve + release target the root, a denied
 * reservation answers the request and never runs the write, a failed / declined
 * write gives the slot back, and a fail-open reservation is never "refunded".
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const reserveQuota = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const decrementQuota = jest.fn();
const sendQuotaReserveDenied = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  reserveQuota: (...a: unknown[]) => reserveQuota(...a),
  decrementQuota: (...a: unknown[]) => decrementQuota(...a),
  sendQuotaReserveDenied: (...a: unknown[]) => sendQuotaReserveDenied(...a),
  getServiceAuthHeader: (o: { orgId: string }) => `Bearer ops@${o.orgId}`,
}));
const resolveAccountRoot = jest.fn<(orgId: string) => Promise<string>>(async () => 'root-1');
class PlatformUnavailableError extends Error {}
jest.unstable_mockModule('../src/services/platform-client.js', () => ({
  resolveAccountRoot: (o: string) => resolveAccountRoot(o),
  PlatformUnavailableError,
}));

const quota = await import('../src/middleware/quota.js');
const granted = { exceeded: false, quota: { resetAt: 'r1' } };
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  reserveQuota.mockReset().mockResolvedValue(granted);
  decrementQuota.mockReset();
  sendQuotaReserveDenied.mockReset();
  resolveAccountRoot.mockReset().mockResolvedValue('root-1');
});

describe('withFeatureQuota', () => {
  it('reserves against the account root and keeps the slot when the write lands', async () => {
    const write = jest.fn(async () => undefined);
    await quota.withFeatureQuota({} as never, 'team-1', 'dashboards', write);
    expect(resolveAccountRoot).toHaveBeenCalledWith('team-1');
    expect(reserveQuota).toHaveBeenCalledWith(quota.quotaService, 'root-1', 'dashboards', 'Bearer ops@root-1');
    expect(write).toHaveBeenCalled();
    await flush();
    expect(decrementQuota).not.toHaveBeenCalled();
  });

  it('answers a denied reservation and never runs the write', async () => {
    reserveQuota.mockResolvedValue({ exceeded: true, quota: {} });
    const write = jest.fn(async () => undefined);
    await quota.withFeatureQuota({} as never, 'o', 'alertRules', write);
    expect(sendQuotaReserveDenied).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('an unresolvable account root is an unconfirmed (503) reservation, not a thrown 500', async () => {
    resolveAccountRoot.mockRejectedValue(new PlatformUnavailableError('platform down'));
    const write = jest.fn(async () => undefined);
    await quota.withFeatureQuota({} as never, 'team-1', 'dashboards', write);
    expect(reserveQuota).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(sendQuotaReserveDenied).toHaveBeenCalledWith(expect.anything(), 'dashboards', expect.objectContaining({ exceeded: true, unavailable: true }));
  });

  it('any other root-resolution error still propagates', async () => {
    resolveAccountRoot.mockRejectedValue(new Error('bug'));
    await expect(quota.withFeatureQuota({} as never, 'o', 'dashboards', async () => undefined)).rejects.toThrow('bug');
  });

  it('gives the slot back when the write declines or throws', async () => {
    await quota.withFeatureQuota({} as never, 'o', 'alertDestinations', async () => false);
    await flush();
    expect(decrementQuota).toHaveBeenCalledWith(quota.quotaService, 'root-1', 'alertDestinations', 'Bearer ops@root-1', expect.any(Function), 1, 'r1');
    decrementQuota.mockClear();
    await expect(quota.withFeatureQuota({} as never, 'o', 'alertDestinations', async () => { throw new Error('db'); })).rejects.toThrow('db');
    await flush();
    expect(decrementQuota).toHaveBeenCalledTimes(1);
  });
});

describe('releaseFeatureQuota', () => {
  it('releases against the root with no reservation in hand (the delete path)', async () => {
    quota.releaseFeatureQuota('o', 'dashboards', () => undefined, null);
    await flush();
    expect(decrementQuota).toHaveBeenCalledWith(quota.quotaService, 'root-1', 'dashboards', 'Bearer ops@root-1', expect.any(Function), 1, undefined);
  });

  it('never refunds a fail-open reservation, and logs a root it could not resolve', async () => {
    quota.releaseFeatureQuota('o', 'dashboards', () => undefined, { exceeded: false, failOpen: true, quota: {} } as never);
    resolveAccountRoot.mockRejectedValueOnce(new Error('platform down'));
    const warn = jest.fn();
    quota.releaseFeatureQuota('o', 'dashboards', warn, null);
    await flush();
    expect(decrementQuota).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('root resolution failed'), { error: 'platform down' });
  });
});
