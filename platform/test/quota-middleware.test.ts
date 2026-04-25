// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

const mockUpdateLimits = jest.fn();
const mockCheck = jest.fn();

jest.mock('@pipeline-builder/api-core', () => ({
  createQuotaService: jest.fn(() => ({
    updateLimits: mockUpdateLimits,
    check: mockCheck,
  })),
}));

jest.mock('../src/config', () => ({
  config: {
    quota: {
      serviceHost: 'quota.test',
      servicePort: 3000,
      serviceTimeout: 5000,
    },
  },
}));

import { updateQuotaLimits, getOrganizationQuotaStatus } from '../src/middleware/quota';

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
