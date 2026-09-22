// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockCheck = jest.fn<AnyFn>();
const mockReserveQuota = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockDecrementQuota = jest.fn<AnyFn>();
const mockGetServiceAuthHeader = jest.fn((..._a: unknown[]) => 'Bearer test');
const mockResolveOrgLineage = jest.fn<(...a: unknown[]) => Promise<{ rootOrgId: string }>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createQuotaService: jest.fn(() => ({
    check: mockCheck,
  })),
  getServiceAuthHeader: (...a: unknown[]) => mockGetServiceAuthHeader(...a),
  reserveQuota: (...a: unknown[]) => mockReserveQuota(...a),
  decrementQuota: (...a: unknown[]) => mockDecrementQuota(...a),
}));

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  quota: {
    serviceHost: 'quota.test',
    servicePort: 3000,
    serviceTimeout: 5000,
  },
}));

jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  isAncestorOrg: async () => false,
  resolveOrgLineage: (...a: unknown[]) => mockResolveOrgLineage(...a),
}));

const { getOrganizationQuotaStatus, reserveFeatureQuota, releaseFeatureQuota, withFeatureQuota } =
  await import('../src/middleware/quota.js');


describe('getOrganizationQuotaStatus', () => {
  beforeEach(() => {
    mockCheck.mockReset();
  });

  it('should return quota check result on success', async () => {
    const checkResult = { allowed: true, current: 5, limit: 100 };
    mockCheck.mockResolvedValue(checkResult);

    const result = await getOrganizationQuotaStatus('org-1', 'plugins', 'Bearer tok');
    expect(result).toEqual(checkResult);
    expect(mockCheck).toHaveBeenCalledWith('org-1', 'plugins', 'Bearer tok');
  });

  it('should return null when quota service throws', async () => {
    mockCheck.mockRejectedValue(new Error('service down'));
    const result = await getOrganizationQuotaStatus('org-1', 'plugins', 'Bearer tok');
    expect(result).toBeNull();
  });

  it('forwards the caller-supplied auth header', async () => {
    mockCheck.mockResolvedValue({ allowed: true });
    await getOrganizationQuotaStatus('org-1', 'pipelines', 'Bearer svc');
    expect(mockCheck).toHaveBeenCalledWith('org-1', 'pipelines', 'Bearer svc');
  });
});

describe('reserveFeatureQuota — reserves against the resolved account ROOT', () => {
  beforeEach(() => {
    mockReserveQuota.mockReset();
    mockGetServiceAuthHeader.mockClear();
    mockResolveOrgLineage.mockReset();
  });

  it('reserves against the ROOT (not the team) so the pooled cap binds', async () => {
    // A team whose own feature limits are seeded to -1; only the root's pooled
    // cap should bind, so the reservation MUST target the root.
    mockResolveOrgLineage.mockResolvedValue({ rootOrgId: 'root-1' });
    mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { type: 'dashboards' } });

    const result = await reserveFeatureQuota('team-9', 'dashboards');

    expect(mockResolveOrgLineage).toHaveBeenCalledWith('team-9');
    // Reservation + auth header are minted for the ROOT, never the team id.
    expect(mockGetServiceAuthHeader).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'root-1' }),
    );
    expect(mockReserveQuota).toHaveBeenCalledWith(
      expect.anything(), 'root-1', 'dashboards', 'Bearer test',
    );
    expect(result).toMatchObject({ exceeded: false });
  });

  it('is a no-op remap for a flat org (rootOrgId === orgId)', async () => {
    mockResolveOrgLineage.mockResolvedValue({ rootOrgId: 'org-flat' });
    mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { type: 'alertRules' } });

    await reserveFeatureQuota('org-flat', 'alertRules');

    expect(mockReserveQuota).toHaveBeenCalledWith(
      expect.anything(), 'org-flat', 'alertRules', 'Bearer test',
    );
  });
});

describe('releaseFeatureQuota — rolls back against the same resolved ROOT', () => {
  beforeEach(() => {
    mockDecrementQuota.mockReset();
    mockResolveOrgLineage.mockReset();
  });

  it('decrements against the ROOT the reservation targeted', async () => {
    mockResolveOrgLineage.mockResolvedValue({ rootOrgId: 'root-1' });
    const logWarn = jest.fn<AnyFn>();

    releaseFeatureQuota('team-9', 'dashboards', logWarn, null);
    // Fire-and-forget: let the resolveOrgLineage promise settle.
    await new Promise((r) => setImmediate(r));

    expect(mockResolveOrgLineage).toHaveBeenCalledWith('team-9');
    expect(mockDecrementQuota).toHaveBeenCalledWith(
      expect.anything(), 'root-1', 'dashboards', 'Bearer test', logWarn, 1, undefined,
    );
  });

  it('a ROLLBACK carries the reservation\'s resetAt as the conditional-decrement snapshot', async () => {
    // If the quota period rolls over between reserve and rollback, the quota
    // service skips a snapshot-mismatched decrement — so a failed create can't
    // steal a slot from the new period.
    mockResolveOrgLineage.mockResolvedValue({ rootOrgId: 'root-1' });
    const logWarn = jest.fn<AnyFn>();
    const reservation = {
      exceeded: false,
      quota: { type: 'dashboards' as const, limit: 10, used: 3, remaining: 7, resetAt: '2026-09-24T00:00:00.000Z' },
    };

    releaseFeatureQuota('team-9', 'dashboards', logWarn, reservation);
    await new Promise((r) => setImmediate(r));

    expect(mockDecrementQuota).toHaveBeenCalledWith(
      expect.anything(), 'root-1', 'dashboards', 'Bearer test', logWarn, 1, '2026-09-24T00:00:00.000Z',
    );
  });

  it('logs (and does not decrement) when root resolution fails', async () => {
    mockResolveOrgLineage.mockRejectedValue(new Error('lineage down'));
    const logWarn = jest.fn<AnyFn>();

    releaseFeatureQuota('team-9', 'dashboards', logWarn, null);
    await new Promise((r) => setImmediate(r));

    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      'Feature-quota release skipped (root resolution failed)',
      expect.objectContaining({ error: 'lineage down' }),
    );
  });
});

describe('withFeatureQuota', () => {
  const resStub = () => {
    const r: any = { headersSent: false };
    r.status = jest.fn(() => r);
    r.json = jest.fn(() => r);
    r.setHeader = jest.fn();
    return r;
  };
  const flush = () => new Promise((r) => setImmediate(r));
  const reservation = { exceeded: false, quota: { resetAt: '2026-01-01T00:00:00.000Z' } };

  beforeEach(() => {
    mockReserveQuota.mockReset();
    mockDecrementQuota.mockReset();
    mockResolveOrgLineage.mockResolvedValue({ rootOrgId: 'root-1' });
  });

  it('answers the request and never runs the write when the quota is exceeded', async () => {
    mockReserveQuota.mockResolvedValue({ exceeded: true, quota: { limit: 1, used: 1, remaining: 0, resetAt: 'x' } });
    const res = resStub();
    const write = jest.fn(async () => undefined);
    await withFeatureQuota(res, 'org-1', 'dashboards', write);
    expect(write).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('keeps the slot when the write succeeds', async () => {
    mockReserveQuota.mockResolvedValue(reservation);
    await withFeatureQuota(resStub(), 'org-1', 'dashboards', async () => undefined);
    await flush();
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });

  it('releases the slot when the write returns false, and rethrows (after releasing) when it throws', async () => {
    mockReserveQuota.mockResolvedValue(reservation);
    await withFeatureQuota(resStub(), 'org-1', 'dashboards', async () => false);
    await flush();
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);

    await expect(withFeatureQuota(resStub(), 'org-1', 'dashboards', async () => { throw new Error('db'); })).rejects.toThrow('db');
    await flush();
    expect(mockDecrementQuota).toHaveBeenCalledTimes(2);
  });
});
