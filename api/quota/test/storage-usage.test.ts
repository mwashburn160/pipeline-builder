// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry storage usage for the quota READS: fail-soft, cached (failures
 * too), and summed across a pool's orgs.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const get = jest.fn<AnyFn>();
const emitCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  emitCounter,
  createSafeClient: () => ({ get }),
  getServiceAuthHeader: () => 'Bearer svc',
  serviceEndpoint: () => ({ host: 'image-registry', port: 3000 }),
}));
jest.unstable_mockModule('../src/config.js', () => ({ config: { quota: { storageUsageCacheTtlMs: 60_000 } } }));

const { clearStorageUsageCache, fetchOrgStorageBytes, fetchStorageBytes } = await import('../src/services/storage-usage.js');

beforeEach(() => {
  jest.clearAllMocks();
  clearStorageUsageCache();
});

describe('fetchOrgStorageBytes', () => {
  it('reads the registry\'s internal route with a quota service token, and caches it', async () => {
    get.mockResolvedValue({ statusCode: 200, body: { data: { bytes: 1234 } } });
    expect(await fetchOrgStorageBytes('org-1')).toBe(1234);
    expect(await fetchOrgStorageBytes('org-1')).toBe(1234);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/internal/storage-usage/org-1', { headers: { authorization: 'Bearer svc' }, maxRetries: 0 });
  });

  it('is fail-soft: non-2xx, unreachable, malformed and thrown all read as null (and are cached)', async () => {
    get.mockResolvedValueOnce({ statusCode: 404, body: {} });
    expect(await fetchOrgStorageBytes('a')).toBeNull();
    get.mockResolvedValueOnce(null);
    expect(await fetchOrgStorageBytes('b')).toBeNull();
    get.mockResolvedValueOnce({ statusCode: 200, body: { data: { bytes: -5 } } });
    expect(await fetchOrgStorageBytes('c')).toBeNull();
    get.mockRejectedValueOnce(new Error('boom'));
    expect(await fetchOrgStorageBytes('d')).toBeNull();
    expect(await fetchOrgStorageBytes('a')).toBeNull(); // cached failure: no second attempt
    expect(get).toHaveBeenCalledTimes(4);
    expect(emitCounter).toHaveBeenCalledWith('quota_storage_usage_read_failed_total', { reason: 'http_404' });
    expect(emitCounter).toHaveBeenCalledWith('quota_storage_usage_read_failed_total', { reason: 'unreachable' });
    expect(emitCounter).toHaveBeenCalledWith('quota_storage_usage_read_failed_total', { reason: 'exception' });
  });
});

describe('fetchStorageBytes', () => {
  it('sums the measured orgs of a pool; null only when none could be measured', async () => {
    get.mockImplementation(async (path: string) => (path.endsWith('/root')
      ? { statusCode: 200, body: { data: { bytes: 100 } } }
      : path.endsWith('/team-a') ? { statusCode: 200, body: { data: { bytes: 50 } } } : null));
    expect(await fetchStorageBytes(['root', 'team-a', 'team-b'])).toBe(150);
    clearStorageUsageCache();
    get.mockResolvedValue(null);
    expect(await fetchStorageBytes(['x', 'y'])).toBeNull();
  });
});
