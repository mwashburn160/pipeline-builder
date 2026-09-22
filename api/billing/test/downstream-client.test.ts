// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared downstream client — the single billing-side transport +
 * parser that `usage-helpers`, `entitlement-drift`, the entitlement push legs
 * and the over-cap guard all funnel through. These lock the tenant handshake and
 * the envelope-parse contract (`data.quota`, `data.status.used`,
 * `data.limit`/`data.used`) so the readers can't drift apart (the `body.used`
 * vs `body.data.used` class of bug).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const clientGet = jest.fn<(path: string, opts?: unknown) => unknown>();
const clientPut = jest.fn<(path: string, body: unknown, opts?: unknown) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: () => ({ get: clientGet, put: clientPut }),
  getServiceAuthHeader: () => 'Bearer test-service',
  setCounterEmitter: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', async () => {
  return stubModule('@pipeline-builder/pipeline-core', {
    Config: { get: () => ({ services: { billingTimeout: 5000 } }) },
    CoreConstants: {
      IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60_000,
      IDEMPOTENCY_TTL_MS: 300_000,
      IDEMPOTENCY_MAX_STORE_SIZE: 10_000,
    },
  });
});

jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    quotaService: { host: 'quota', port: 3000 },
    platformService: { host: 'platform', port: 3000 },
  },
}));

const { fetchQuotaSnapshot, fetchQuotaTypeUsage, fetchSeatUsage, getJson, putJson } = await import('../src/helpers/downstream-client.js');

beforeEach(() => { clientGet.mockReset(); clientPut.mockReset(); });

const TARGET = { host: 'reporting', port: 3000 };

describe('getJson', () => {
  it('returns the body of a 2xx and sends the tenant headers', async () => {
    clientGet.mockReturnValue({ statusCode: 200, body: { data: { sets: ['standard'] } } });
    expect(await getJson(TARGET, '/x/org-1', 'org-1', 'Bearer x')).toEqual({ data: { sets: ['standard'] } });
    expect(clientGet).toHaveBeenCalledWith('/x/org-1', { headers: { 'Authorization': 'Bearer x', 'x-org-id': 'org-1' } });
  });

  it('is fail-soft: null on non-2xx, transport failure, or a thrown error', async () => {
    clientGet.mockReturnValue({ statusCode: 503, body: {} });
    expect(await getJson(TARGET, '/x', 'org-1', 'Bearer x')).toBeNull();
    clientGet.mockReturnValue(null);
    expect(await getJson(TARGET, '/x', 'org-1', 'Bearer x')).toBeNull();
    clientGet.mockImplementation(() => { throw new Error('boom'); });
    expect(await getJson(TARGET, '/x', 'org-1', 'Bearer x')).toBeNull();
  });
});

describe('putJson', () => {
  it('PUTs the body with tenant headers and reports the status', async () => {
    clientPut.mockReturnValue({ statusCode: 204, body: null });
    expect(await putJson(TARGET, '/y/org-1', { a: 1 }, 'org-1', 'Bearer x')).toEqual({ statusCode: 204 });
    expect(clientPut).toHaveBeenCalledWith('/y/org-1', { a: 1 }, { headers: { 'Authorization': 'Bearer x', 'x-org-id': 'org-1' } });
  });

  it('returns null on a transport failure', async () => {
    clientPut.mockReturnValue(null);
    expect(await putJson(TARGET, '/y', {}, 'org-1', 'Bearer x')).toBeNull();
  });
});

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

});

describe('fetchQuotaTypeUsage', () => {
  it('reads data.status.used from GET /quotas/:orgId/:type', async () => {
    clientGet.mockReturnValue({ statusCode: 200, body: { data: { status: { used: 42 } } } });
    expect(await fetchQuotaTypeUsage('org-1', 'plugins', 'Bearer x')).toBe(42);
    expect(clientGet).toHaveBeenCalledWith('/quotas/org-1/plugins', { headers: { 'Authorization': 'Bearer x', 'x-org-id': 'org-1' } });
  });

  it('returns null on a missing value, non-2xx, or transport failure', async () => {
    clientGet.mockReturnValue({ statusCode: 200, body: { data: {} } });
    expect(await fetchQuotaTypeUsage('org-1', 'plugins', 'Bearer x')).toBeNull();
    clientGet.mockReturnValue({ statusCode: 404, body: {} });
    expect(await fetchQuotaTypeUsage('org-1', 'plugins', 'Bearer x')).toBeNull();
    clientGet.mockReturnValue(null);
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

  it('is fail-soft on a transport failure (the safe client resolves null)', async () => {
    clientGet.mockReturnValue(null);
    expect(await fetchSeatUsage('org-1', 'Bearer x')).toBeNull();
  });
});
