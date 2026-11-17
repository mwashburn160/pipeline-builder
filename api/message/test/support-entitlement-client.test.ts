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

/** Every request the client made through the shared http-client. */
const httpCalls: Array<{ config: Record<string, unknown>; clientOpts: Record<string, unknown>; path: string; options: Record<string, any> }> = [];
let reply: () => Promise<{ statusCode: number; body: unknown }> = async () => ({ statusCode: 200, body: {} });
class FakeHttpClient {
  constructor(private readonly config: Record<string, unknown>, private readonly clientOpts: Record<string, unknown> = {}) {}
  async get(path: string, options: Record<string, unknown>) {
    httpCalls.push({ config: this.config, clientOpts: this.clientOpts, path, options });
    return { ...(await reply()), headers: {} };
  }
}

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  InternalHttpClient: FakeHttpClient,
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

/** Answer the next read with `init` (an Error is a transport failure / timeout / open breaker). */
function respond(init: { ok: boolean; status?: number; body?: unknown } | Error): void {
  reply = init instanceof Error
    ? async () => { throw init; }
    : async () => ({ statusCode: init.status ?? (init.ok ? 200 : 500), body: init.body ?? {} });
}

beforeEach(() => {
  httpCalls.length = 0;
  mockCacheGet.mockReset().mockResolvedValue(null);
  mockCacheSet.mockReset().mockResolvedValue(undefined);
  mockIncCounter.mockReset();
});

describe('a healthy read', () => {
  it('reads platform through the shared client with the service token, one bounded attempt', async () => {
    respond({ ok: true, body: { data: GRANT } });
    await fetchSupportEntitlement('a/b');
    expect(httpCalls).toHaveLength(1);
    const [call] = httpCalls;
    expect(call.config).toEqual({ host: 'platform', port: 3000, timeout: 3000 });
    expect(call.clientOpts).toEqual({ maxResponseBytes: 64 * 1024 });
    expect(call.path).toBe('/internal/support/entitlement/a%2Fb');
    expect(call.options.headers).toEqual({ Authorization: 'Bearer service-token' });
    // No hidden retries: the 3s bound is the whole budget a send pays.
    expect(call.options).toMatchObject({ maxRetries: 0, maxRateLimitRetries: 0 });
  });

  it('returns the entitlement and caches it', async () => {
    respond({ ok: true, body: { data: GRANT } });
    await expect(fetchSupportEntitlement('org-1')).resolves.toMatchObject({ level: 'support_premium', canOpenCase: true });
    expect(mockCacheSet).toHaveBeenCalledWith('org-1', expect.objectContaining({ canOpenCase: true }));
  });

  it('reads the {data} envelope the contract defines — an unwrapped body is malformed', async () => {
    // Platform's entitlement route answers through `sendSuccess`, and the
    // endpoint's contract (api-core PLATFORM_INTERNAL.supportEntitlement) parses
    // the envelope's `data`. A bare body is not that answer: null, not cached.
    respond({ ok: true, body: GRANT });
    await expect(fetchSupportEntitlement('org-1')).resolves.toBeNull();
    expect(mockCacheSet).not.toHaveBeenCalled();
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

  it('an unparseable body (the client hands back {}) degrades as malformed', async () => {
    respond({ ok: true, body: {} });
    await expect(fetchSupportEntitlement('org-1')).resolves.toBeNull();
    expect(mockIncCounter).toHaveBeenCalledWith('support_entitlement_unavailable_total', { reason: 'malformed' });
  });

  it('a JSON null body degrades rather than throwing', async () => {
    respond({ ok: true, body: null });
    await expect(fetchSupportEntitlement('org-1')).resolves.toBeNull();
  });

  it('does not cache a malformed answer', async () => {
    respond({ ok: true, body: { data: {} } });
    await fetchSupportEntitlement('org-1');
    expect(mockCacheSet).not.toHaveBeenCalled();
  });
});
