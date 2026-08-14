// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockUpdateLimits = jest.fn();
const mockCheck = jest.fn();
const mockReserveQuota = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockDecrementQuota = jest.fn();
const mockGetServiceAuthHeader = jest.fn((...a: unknown[]) => 'Bearer test');
const mockResolveOrgLineage = jest.fn<(...a: unknown[]) => Promise<{ rootOrgId: string }>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createQuotaService: jest.fn(() => ({
    updateLimits: mockUpdateLimits,
    check: mockCheck,
  })),
  getServiceAuthHeader: (...a: unknown[]) => mockGetServiceAuthHeader(...a),
  reserveQuota: (...a: unknown[]) => mockReserveQuota(...a),
  decrementQuota: (...a: unknown[]) => mockDecrementQuota(...a),
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    quota: {
      serviceHost: 'quota.test',
      servicePort: 3000,
      serviceTimeout: 5000,
    },
  },
}));

jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  resolveOrgLineage: (...a: unknown[]) => mockResolveOrgLineage(...a),
}));

const { updateQuotaLimits, getOrganizationQuotaStatus, reserveFeatureQuota, releaseFeatureQuota } =
  await import('../src/middleware/quota.js');


describe('updateQuotaLimits', () => {
  beforeEach(() => {
    mockUpdateLimits.mockReset();
  });

  it('should delegate to quotaService.updateLimits', async () => {
    mockUpdateLimits.mockResolvedValue(true);
    const result = await updateQuotaLimits('org-1', { plugins: 50 }, 'Bearer tok');
    expect(result).toBe(true);
    expect(mockUpdateLimits).toHaveBeenCalledWith('org-1', { plugins: 50 }, 'Bearer tok');
  });

  it('should return false when quota service returns false', async () => {
    mockUpdateLimits.mockResolvedValue(false);
    const result = await updateQuotaLimits('org-1', {}, 'Bearer tok');
    expect(result).toBe(false);
  });

  it('should propagate errors from quota service', async () => {
    mockUpdateLimits.mockRejectedValue(new Error('upstream'));
    await expect(updateQuotaLimits('org-1', {}, 'Bearer tok')).rejects.toThrow('upstream');
  });
});

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

  it('should default authHeader to empty string', async () => {
    mockCheck.mockResolvedValue({ allowed: true });
    await getOrganizationQuotaStatus('org-1', 'pipelines');
    expect(mockCheck).toHaveBeenCalledWith('org-1', 'pipelines', '');
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
    const logWarn = jest.fn();

    releaseFeatureQuota('team-9', 'dashboards', logWarn);
    // Fire-and-forget: let the resolveOrgLineage promise settle.
    await new Promise((r) => setImmediate(r));

    expect(mockResolveOrgLineage).toHaveBeenCalledWith('team-9');
    expect(mockDecrementQuota).toHaveBeenCalledWith(
      expect.anything(), 'root-1', 'dashboards', 'Bearer test', logWarn,
    );
  });

  it('logs (and does not decrement) when root resolution fails', async () => {
    mockResolveOrgLineage.mockRejectedValue(new Error('lineage down'));
    const logWarn = jest.fn();

    releaseFeatureQuota('team-9', 'dashboards', logWarn);
    await new Promise((r) => setImmediate(r));

    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      'Feature-quota release skipped (root resolution failed)',
      expect.objectContaining({ error: 'lineage down' }),
    );
  });
});
