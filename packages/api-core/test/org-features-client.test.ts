// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An org's resolved feature flags from platform (`PLATFORM_INTERNAL.orgFeatures`):
 * a token scoped to the org asked about, `[]` for an unknown org, and a THROW
 * for anything else — a caller must be able to tell "no feature" from "could not ask".
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockGet = jest.fn<(path: string, opts?: unknown) => Promise<unknown>>();
jest.unstable_mockModule('../src/services/http-client.js', () => ({
  createSafeClient: () => ({ get: (path: string, opts?: unknown) => mockGet(path, opts) }),
}));
jest.unstable_mockModule('../src/middleware/service-tokens.js', () => ({
  getServiceAuthHeader: (o: { orgId: string }) => `Bearer svc-for-${o.orgId}`,
}));

const { fetchOrgFeatures } = await import('../src/services/org-features-client.js');

const ORG = '0123456789abcdef01234567';
beforeEach(() => { mockGet.mockReset(); });

describe('fetchOrgFeatures', () => {
  it('reads the org\'s flags with a token scoped to it', async () => {
    mockGet.mockResolvedValue({ statusCode: 200, body: { success: true, data: { features: ['cross_account_runners', 7] } } });
    expect(await fetchOrgFeatures(ORG)).toEqual(['cross_account_runners']);
    expect(mockGet).toHaveBeenCalledWith(`/internal/features/${ORG}`, { headers: { Authorization: `Bearer svc-for-${ORG}` } });
  });

  it('an unknown org holds no features', async () => {
    mockGet.mockResolvedValue({ statusCode: 404, body: { success: false } });
    expect(await fetchOrgFeatures(ORG)).toEqual([]);
  });

  it('throws when platform cannot answer (unreachable, 5xx)', async () => {
    mockGet.mockResolvedValue(null);
    await expect(fetchOrgFeatures(ORG)).rejects.toThrow(/unreachable/);
    mockGet.mockResolvedValue({ statusCode: 500, body: {} });
    await expect(fetchOrgFeatures(ORG)).rejects.toThrow(/HTTP 500|status/);
  });
});
