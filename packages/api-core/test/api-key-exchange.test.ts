// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The opaque-key → JWT exchange client: key-format recognition, the in-process
 * cache (hit / early refresh / expiry), single-flight, the negative cache, and
 * the two failure shapes a caller must tell apart (refused vs unavailable).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const post = jest.fn<(...a: any[]) => any>();

jest.unstable_mockModule('../src/services/http-client.js', () => ({
  InternalHttpClient: jest.fn(() => ({ post })),
}));
jest.unstable_mockModule('../src/middleware/service-tokens.js', () => ({
  getServiceAuthHeader: () => 'Bearer svc',
}));

const {
  exchangeApiKey,
  resetApiKeyExchangeCache,
  ApiKeyRejectedError,
  ApiKeyExchangeUnavailableError,
} = await import('../src/services/api-key-exchange.js');
const { isOpaqueApiKey, apiKeyPrefixOf, generateApiKey, hashApiKey } = await import('../src/utils/api-key.js');

/** A platform 200 with `ttl` seconds of token life. */
function ok(token: string, ttl = 300) {
  return { statusCode: 200, body: { success: true, data: { accessToken: token, expiresIn: ttl } }, headers: {} };
}

const KEY = 'pb_pat_0123456789abcdef0123456789abcdef0123456789a';

beforeEach(() => {
  jest.clearAllMocks();
  resetApiKeyExchangeCache();
});

describe('key format', () => {
  it('recognizes both minted prefixes and nothing else', () => {
    expect(isOpaqueApiKey(generateApiKey('pb_pat'))).toBe(true);
    expect(isOpaqueApiKey(generateApiKey('pb_sa'))).toBe(true);
    expect(apiKeyPrefixOf(generateApiKey('pb_sa'))).toBe('pb_sa');
    // A JWT, a near-miss prefix, and a too-short secret must NOT route to the
    // exchange path — that decision is what keeps a malformed header from
    // turning every request into a platform round-trip.
    expect(isOpaqueApiKey('eyJhbGciOiJIUzI1NiJ9.e30.abc')).toBe(false);
    expect(isOpaqueApiKey('pb_xx_0123456789abcdef0123456789abcdef012')).toBe(false);
    expect(isOpaqueApiKey('pb_pat_short')).toBe(false);
    expect(isOpaqueApiKey(undefined)).toBe(false);
  });

  it('hashes deterministically and never returns the key', () => {
    const key = generateApiKey('pb_pat');
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).not.toContain(key);
  });
});

describe('exchangeApiKey', () => {
  it('exchanges once and serves the cached token afterwards', async () => {
    post.mockResolvedValue(ok('jwt-1'));
    expect(await exchangeApiKey(KEY)).toBe('jwt-1');
    expect(await exchangeApiKey(KEY)).toBe('jwt-1');
    expect(await exchangeApiKey(KEY)).toBe('jwt-1');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('/auth/token/exchange');
    // The key travels in the BODY (never a URL, where it would land in logs),
    // and the call carries this service's own token so platform's IP-keyed
    // /auth limiter doesn't count every pod's exchanges in one bucket.
    expect(post.mock.calls[0][1]).toEqual({ key: KEY });
    expect((post.mock.calls[0][2] as any).headers.Authorization).toBe('Bearer svc');
  });

  it('shares ONE round-trip across concurrent callers', async () => {
    let release: (v: unknown) => void = () => {};
    post.mockImplementation(() => new Promise((r) => { release = r; }));
    const all = Promise.all([exchangeApiKey(KEY), exchangeApiKey(KEY), exchangeApiKey(KEY)]);
    release(ok('jwt-concurrent'));
    expect(await all).toEqual(['jwt-concurrent', 'jwt-concurrent', 'jwt-concurrent']);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('re-exchanges once the cached token has expired', async () => {
    post.mockResolvedValueOnce(ok('jwt-a', 0.001)).mockResolvedValueOnce(ok('jwt-b'));
    expect(await exchangeApiKey(KEY)).toBe('jwt-a');
    await new Promise((r) => setTimeout(r, 5));
    expect(await exchangeApiKey(KEY)).toBe('jwt-b');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('refreshes EARLY in the background without making the request wait', async () => {
    // 1s of life → the jittered refresh point (65–85% of it) has passed at
    // 880ms, while the token itself is still valid for another 120ms.
    post.mockResolvedValueOnce(ok('jwt-old', 1)).mockResolvedValueOnce(ok('jwt-new'));
    expect(await exchangeApiKey(KEY)).toBe('jwt-old');
    await new Promise((r) => setTimeout(r, 880));
    // Still the OLD token — the refresh is fire-and-forget, never blocking.
    expect(await exchangeApiKey(KEY)).toBe('jwt-old');
    await new Promise((r) => setTimeout(r, 20));
    expect(post).toHaveBeenCalledTimes(2);
    expect(await exchangeApiKey(KEY)).toBe('jwt-new');
  });

  it('keeps serving the cached token when a background refresh fails', async () => {
    post.mockResolvedValueOnce(ok('jwt-live', 1)).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await exchangeApiKey(KEY)).toBe('jwt-live');
    await new Promise((r) => setTimeout(r, 880));
    await expect(exchangeApiKey(KEY)).resolves.toBe('jwt-live');
  });

  it('rejects a refused key and remembers the refusal (no second round-trip)', async () => {
    post.mockResolvedValue({ statusCode: 401, body: { success: false }, headers: {} });
    await expect(exchangeApiKey(KEY)).rejects.toBeInstanceOf(ApiKeyRejectedError);
    await expect(exchangeApiKey(KEY)).rejects.toBeInstanceOf(ApiKeyRejectedError);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('reports platform being unreachable as UNAVAILABLE, and never caches it', async () => {
    post.mockRejectedValue(new Error('connect ETIMEDOUT'));
    await expect(exchangeApiKey(KEY)).rejects.toBeInstanceOf(ApiKeyExchangeUnavailableError);
    // Not a rejection: the key's validity is unknown, so the next request must
    // ask again rather than treating the outage as "invalid".
    post.mockResolvedValue(ok('jwt-after-recovery'));
    expect(await exchangeApiKey(KEY)).toBe('jwt-after-recovery');
  });

  it('treats a 5xx / 429 as unavailable, not as a refusal', async () => {
    post.mockResolvedValueOnce({ statusCode: 503, body: {}, headers: {} });
    await expect(exchangeApiKey(KEY)).rejects.toBeInstanceOf(ApiKeyExchangeUnavailableError);
    post.mockResolvedValueOnce({ statusCode: 429, body: {}, headers: {} });
    await expect(exchangeApiKey(KEY)).rejects.toBeInstanceOf(ApiKeyExchangeUnavailableError);
    post.mockResolvedValueOnce(ok('jwt-recovered'));
    expect(await exchangeApiKey(KEY)).toBe('jwt-recovered');
  });

  it('treats a 200 with no token as unavailable rather than passing nothing on', async () => {
    post.mockResolvedValueOnce({ statusCode: 200, body: { success: true, data: {} }, headers: {} });
    await expect(exchangeApiKey(KEY)).rejects.toBeInstanceOf(ApiKeyExchangeUnavailableError);
  });

  it('caches per key — one key\'s token is never served for another', async () => {
    const other = 'pb_pat_ffffffffffffffffffffffffffffffffffffffffffe';
    post.mockResolvedValueOnce(ok('jwt-one')).mockResolvedValueOnce(ok('jwt-two'));
    expect(await exchangeApiKey(KEY)).toBe('jwt-one');
    expect(await exchangeApiKey(other)).toBe('jwt-two');
    expect(await exchangeApiKey(KEY)).toBe('jwt-one');
    expect(post).toHaveBeenCalledTimes(2);
  });
});
