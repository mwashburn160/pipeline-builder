// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Support-entitlement reads and their degraded behaviour.
 *
 * Every assertion here is about a path that only runs when something is already
 * wrong, which is exactly why they are worth pinning: nobody exercises them by
 * hand, and getting them wrong either denies a paying customer support during
 * our own outage or hands out support nobody bought.
 *
 * The layering under test:
 *   live read ok      -> answer, and cache it
 *   live read fails   -> last-known-good from cache, if still within TTL
 *   cache cold/expired-> null, i.e. "send the message, skip the case"
 *   malformed body    -> null, and deliberately NOT cached
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockCacheGet = jest.fn<AnyFn>();
const mockCacheSet = jest.fn<AnyFn>();
const mockIncCounter = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({ warn: () => {}, info: () => {}, debug: () => {}, error: () => {} }),
  createCacheService: () => ({ get: mockCacheGet, set: mockCacheSet, del: jest.fn<AnyFn>() }),
  getServiceAuthHeader: () => 'Bearer service-token',
  envInt: (_n: string, d: number) => d,
  errorMessage: (e: unknown) => String(e),
  SYSTEM_ORG_ID: '000000000000000000000001',
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: mockIncCounter,
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ services: { platformHost: 'platform', platformPort: 3000 } }) },
}));

const { fetchSupportEntitlement } = await import('../src/services/support-entitlement-client.js');

const GRANT = {
  level: 'support_premium',
  limit: 5,
  used: 3,
  ownOrgContacts: 2,
  canDesignate: true,
  canOpenCase: true,
};

/** Replace global fetch for one call. */
function respond(init: { ok: boolean; status?: number; body?: unknown } | Error): void {
  (global as { fetch: unknown }).fetch = init instanceof Error
    ? jest.fn<AnyFn>(async () => { throw init; })
    : jest.fn<AnyFn>(async () => ({ ok: init.ok, status: init.status ?? 200, json: async () => init.body }));
}

beforeEach(() => {
  mockCacheGet.mockReset().mockResolvedValue(null);
  mockCacheSet.mockReset().mockResolvedValue(undefined);
  mockIncCounter.mockReset();
});

describe('a healthy read', () => {
  it('returns the entitlement and caches it', async () => {
    respond({ ok: true, body: { data: GRANT } });
    await expect(fetchSupportEntitlement('org-1')).resolves.toMatchObject({ level: 'support_premium', canOpenCase: true });
    expect(mockCacheSet).toHaveBeenCalledWith('org-1', expect.objectContaining({ canOpenCase: true }));
  });

  it('accepts an unwrapped body as well as a {data} envelope', async () => {
    // Platform's responders are not uniform; a shape assumption here would
    // degrade every send against the service that answers the other way.
    respond({ ok: true, body: GRANT });
    await expect(fetchSupportEntitlement('org-1')).resolves.toMatchObject({ canOpenCase: true });
  });

  it('caches a NEGATIVE answer too', async () => {
    // Otherwise an outage turns an unentitled org into a degraded one, which
    // reads to staff like a different fault entirely.
    respond({ ok: true, body: { data: { ...GRANT, level: null, canOpenCase: false, ownOrgContacts: 0 } } });
    await expect(fetchSupportEntitlement('org-1')).resolves.toMatchObject({ canOpenCase: false });
    expect(mockCacheSet).toHaveBeenCalled();
  });
});

describe('degraded: the live read fails', () => {
  it('serves LAST-KNOWN-GOOD when the platform is unreachable', async () => {
    mockCacheGet.mockResolvedValue(GRANT);
    respond(new Error('ECONNREFUSED'));
    await expect(fetchSupportEntitlement('org-1')).resolves.toMatchObject({ level: 'support_premium', canOpenCase: true });
    expect(mockIncCounter).toHaveBeenCalledWith('support_entitlement_degraded_total', { reason: 'unreachable', cache: 'hit' });
  });

  it('serves last-known-good on a non-2xx as well', async () => {
    mockCacheGet.mockResolvedValue(GRANT);
    respond({ ok: false, status: 503 });
    await expect(fetchSupportEntitlement('org-1')).resolves.toMatchObject({ canOpenCase: true });
    expect(mockIncCounter).toHaveBeenCalledWith('support_entitlement_degraded_total', { reason: 'non_ok', cache: 'hit' });
  });

  it('returns null — send the message, skip the case — on a COLD cache', async () => {
    mockCacheGet.mockResolvedValue(null);
    respond(new Error('timeout'));
    await expect(fetchSupportEntitlement('org-1')).resolves.toBeNull();
    expect(mockIncCounter).toHaveBeenCalledWith('support_entitlement_degraded_total', { reason: 'unreachable', cache: 'miss' });
  });

  it('never throws, so a support send cannot fail because of this read', async () => {
    mockCacheGet.mockRejectedValue(new Error('redis down'));
    respond(new Error('platform down'));
    // Both the live read AND the cache are broken: still resolves.
    await expect(fetchSupportEntitlement('org-1')).resolves.toBeNull();
  });
});

describe('a malformed body is OUR bug, not an outage', () => {
  it('returns null and does NOT fall back to the cache', async () => {
    // Masking a broken contract with a stale grant would hide it until the TTL
    // expired — and the grant would be honoured the whole time.
    mockCacheGet.mockResolvedValue(GRANT);
    respond({ ok: true, body: { data: { level: 'support_premium' } } }); // no canOpenCase
    await expect(fetchSupportEntitlement('org-1')).resolves.toBeNull();
    expect(mockCacheGet).not.toHaveBeenCalled();
  });

  it('rejects a non-string, non-null level', async () => {
    respond({ ok: true, body: { data: { ...GRANT, level: 42 } } });
    await expect(fetchSupportEntitlement('org-1')).resolves.toBeNull();
  });

  it('does not cache a malformed answer', async () => {
    respond({ ok: true, body: { data: {} } });
    await fetchSupportEntitlement('org-1');
    expect(mockCacheSet).not.toHaveBeenCalled();
  });
});
