// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared quota/seat client — the single billing-side parser that
 * `usage-helpers`, `entitlement-drift`, and the over-cap guard all funnel
 * through. These lock the envelope-parse contract (`data.quota`,
 * `data.status.used`, `data.limit`/`data.used`) so the three readers can't
 * drift apart again (the Wave-2 `body.used` vs `body.data.used` class of bug).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const clientGet = jest.fn<(path: string, opts?: unknown) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: () => ({ get: clientGet }),
  getServiceAuthHeader: () => 'Bearer test-service',
  setCounterEmitter: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', async () => {
  // quota-client transitively links billing-helpers, which imports
  // effectiveEntitlements; the export must exist for ESM linking.
  const { effectiveEntitlements } = await import(
    '@pipeline-builder/pipeline-core/lib/config/entitlements.js'
  );
  return {
    Config: { get: () => ({ services: { billingTimeout: 5000 } }) },
    effectiveEntitlements,
    CoreConstants: {
      IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60_000,
      IDEMPOTENCY_TTL_MS: 300_000,
      IDEMPOTENCY_MAX_STORE_SIZE: 10_000,
    },
  };
});

jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    quotaService: { host: 'quota', port: 3000 },
    platformService: { host: 'platform', port: 3000 },
  },
}));

const { fetchQuotaSnapshot, fetchQuotaTypeUsage, fetchSeatUsage } = await import('../src/helpers/quota-client.js');

beforeEach(() => clientGet.mockReset());

describe('fetchQuotaSnapshot', () => {
  it('parses data.quota from a 2xx envelope', async () => {
    clientGet.mockReturnValue({
      statusCode: 200,
      body: { success: true, data: { quota: { tier: 'team', quotas: { plugins: { limit: 100, used: 3 } } } } },
    });
    const snap = await fetchQuotaSnapshot('org-1', 'Bearer x');
    expect(snap?.tier).toBe('team');
    expect(snap?.quotas.plugins.limit).toBe(100);
    // Hits GET /quotas/:orgId with tenant headers.
    expect(clientGet).toHaveBeenCalledWith('/quotas/org-1', { headers: { 'Authorization': 'Bearer x', 'x-org-id': 'org-1' } });
  });

  it('returns null on a non-2xx status', async () => {
    clientGet.mockReturnValue({ statusCode: 500, body: {} });
    expect(await fetchQuotaSnapshot('org-1', 'Bearer x')).toBeNull();
  });

  it('returns null when the client returns null (transport failure)', async () => {
    clientGet.mockReturnValue(null);
    expect(await fetchQuotaSnapshot('org-1', 'Bearer x')).toBeNull();
  });

  it('returns null when data.quota is absent on a 2xx', async () => {
    clientGet.mockReturnValue({ statusCode: 200, body: { success: true, data: {} } });
    expect(await fetchQuotaSnapshot('org-1', 'Bearer x')).toBeNull();
  });

  it('is fail-soft when the client throws', async () => {
    clientGet.mockImplementation(() => { throw new Error('boom'); });
    expect(await fetchQuotaSnapshot('org-1', 'Bearer x')).toBeNull();
  });
});

describe('fetchQuotaTypeUsage', () => {
  it('reads data.status.used from GET /quotas/:orgId/:type', async () => {
    clientGet.mockReturnValue({ statusCode: 200, body: { data: { status: { used: 42 } } } });
    expect(await fetchQuotaTypeUsage('org-1', 'plugins', 'Bearer x')).toBe(42);
    expect(clientGet).toHaveBeenCalledWith('/quotas/org-1/plugins', { headers: { 'Authorization': 'Bearer x', 'x-org-id': 'org-1' } });
  });

  it('returns null on a missing value or non-2xx', async () => {
    clientGet.mockReturnValue({ statusCode: 200, body: { data: {} } });
    expect(await fetchQuotaTypeUsage('org-1', 'plugins', 'Bearer x')).toBeNull();
    clientGet.mockReturnValue({ statusCode: 404, body: {} });
    expect(await fetchQuotaTypeUsage('org-1', 'plugins', 'Bearer x')).toBeNull();
  });
});

describe('fetchSeatUsage', () => {
  it('parses both data.limit and data.used', async () => {
    clientGet.mockReturnValue({ statusCode: 200, body: { success: true, data: { limit: 25, used: 12 } } });
    expect(await fetchSeatUsage('org-1', 'Bearer x')).toEqual({ limit: 25, used: 12 });
    expect(clientGet).toHaveBeenCalledWith('/organization/org-1/seat-usage', { headers: { 'Authorization': 'Bearer x', 'x-org-id': 'org-1' } });
  });

  it('nulls only the field that is missing / non-numeric (not the whole read)', async () => {
    clientGet.mockReturnValue({ statusCode: 200, body: { data: { limit: 25 } } });
    expect(await fetchSeatUsage('org-1', 'Bearer x')).toEqual({ limit: 25, used: null });
  });

  it('returns null on a non-2xx status', async () => {
    clientGet.mockReturnValue({ statusCode: 502, body: { success: false } });
    expect(await fetchSeatUsage('org-1', 'Bearer x')).toBeNull();
  });

  it('is fail-soft when the client throws', async () => {
    clientGet.mockImplementation(() => { throw new Error('refused'); });
    expect(await fetchSeatUsage('org-1', 'Bearer x')).toBeNull();
  });
});
