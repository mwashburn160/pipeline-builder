// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The reporting-API credential exchange.
 *
 * This module had the worst statement-to-branch coverage gap in the repo (95%
 * of lines run, 78% of branches), and every untested branch here is a REFUSAL
 * path — a missing base URL, a rejected key, a malformed body. Those are the
 * paths that decide whether a batch fails loudly or ships events
 * unauthenticated, so they are the ones worth pinning.
 *
 * Reading them also turned up a real contradiction, now fixed and asserted
 * below: the cache used to hold a token for `max(30s, ttl * 0.8)`, which for a
 * short `expiresIn` outlived the token itself.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn((params: unknown) => params),
}));

const { getAuthToken, invalidateCredential, _resetAuthForTests } = await import('../src/auth.js');

/** A fetch stub standing in for platform's `/api/auth/token/exchange`. */
function exchangeReturns(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const res = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
  const spy = jest.fn<(url: unknown, init?: unknown) => Promise<typeof res>>().mockResolvedValue(res);
  (globalThis as { fetch: unknown }).fetch = spy;
  return spy;
}

/** A body whose `json()` rejects, exercising the `.catch(() => ({}))` branch. */
function exchangeReturnsUnparseable() {
  const spy = jest.fn<(url: unknown, init?: unknown) => Promise<unknown>>().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
  });
  (globalThis as { fetch: unknown }).fetch = spy;
  return spy;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  _resetAuthForTests();
  jest.clearAllMocks();
  process.env.PLATFORM_BASE_URL = 'https://platform.test';
  process.env.PLATFORM_ACCESS_KEY = 'pb_sa_testkey';
});

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete process.env.PLATFORM_BASE_URL;
  delete process.env.PLATFORM_ACCESS_KEY;
});

describe('configuration refusals', () => {
  it('names the missing variable rather than failing at the fetch', async () => {
    delete process.env.PLATFORM_BASE_URL;
    const spy = exchangeReturns({ data: { accessToken: 't', expiresIn: 300 } });
    await expect(getAuthToken()).rejects.toThrow('PLATFORM_BASE_URL environment variable is required');
    // Refused BEFORE any network call: an unset base URL is a deployment
    // mistake, and a request to `undefined/api/...` reports it as a DNS error.
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats an empty base URL the same as an unset one', async () => {
    process.env.PLATFORM_BASE_URL = '';
    await expect(getAuthToken()).rejects.toThrow('PLATFORM_BASE_URL environment variable is required');
  });

  it('strips trailing slashes, so the URL never doubles up', async () => {
    process.env.PLATFORM_BASE_URL = 'https://platform.test///';
    const spy = exchangeReturns({ data: { accessToken: 't', expiresIn: 300 } });
    await getAuthToken();
    expect(spy.mock.calls[0]?.[0]).toBe('https://platform.test/api/auth/token/exchange');
  });
});

describe('exchange refusals', () => {
  it.each([[401], [403]])('%i says what an operator must check', async (status) => {
    exchangeReturns({}, { ok: false, status });
    // Platform answers every refusal identically on purpose, so the message
    // has to enumerate the causes rather than echo an opaque status.
    await expect(getAuthToken()).rejects.toThrow(
      new RegExp(`Access-key exchange refused \\(${status}\\).*revoked.*IP allowlist`, 's'),
    );
  });

  it('reports any other status plainly, without guessing a cause', async () => {
    exchangeReturns({}, { ok: false, status: 503 });
    await expect(getAuthToken()).rejects.toThrow('Access-key exchange failed: 503');
  });

  it('fails when the body carries no token', async () => {
    exchangeReturns({ data: {} });
    await expect(getAuthToken()).rejects.toThrow('Access-key exchange returned no access token');
  });

  it('fails when the body is not JSON at all', async () => {
    // `res.json().catch(() => ({}))` swallows the parse error, so the NEXT
    // check is what must refuse — otherwise a proxy's HTML error page becomes
    // an undefined token presented to the API.
    exchangeReturnsUnparseable();
    await expect(getAuthToken()).rejects.toThrow('Access-key exchange returned no access token');
  });

  it('caches nothing after a failure, so the next call retries', async () => {
    exchangeReturns({}, { ok: false, status: 503 });
    await expect(getAuthToken()).rejects.toThrow();
    const ok = exchangeReturns({ data: { accessToken: 'fresh', expiresIn: 300 } });
    await expect(getAuthToken()).resolves.toBe('fresh');
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe('caching', () => {
  it('serves a warm container from cache instead of re-exchanging', async () => {
    const spy = exchangeReturns({ data: { accessToken: 'tok', expiresIn: 300 } });
    await expect(getAuthToken()).resolves.toBe('tok');
    await expect(getAuthToken()).resolves.toBe('tok');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('NEVER caches a token past its own expiry, at any TTL', async () => {
    // The regression this file exists to pin. The cache used to hold
    // `max(30s, ttl * 0.8)`, so a short-lived token was served after it died —
    // against this module's stated contract. Checked across the range because
    // the old floor only bit below ~37s, which is exactly why nobody saw it.
    for (const expiresIn of [1, 5, 10, 30, 37, 60, 300, 900]) {
      _resetAuthForTests();
      jest.clearAllMocks();
      exchangeReturns({ data: { accessToken: `t${expiresIn}`, expiresIn } });
      const before = Date.now();
      await getAuthToken();
      // Re-exchange must happen strictly before the token dies.
      const spy = exchangeReturns({ data: { accessToken: 'second', expiresIn } });
      jest.spyOn(Date, 'now').mockReturnValue(before + expiresIn * 1000 - 1);
      await getAuthToken();
      jest.restoreAllMocks();
      expect({ expiresIn, reExchanged: spy.mock.calls.length > 0 })
        .toEqual({ expiresIn, reExchanged: true });
    }
  });

  it('falls back to 300s when expiresIn is missing or unusable', async () => {
    // A provider that omits it, sends a string, or sends 0 must not produce a
    // NaN deadline — which would compare false forever and re-exchange per call.
    for (const bad of [undefined, 0, -1, 'soon' as unknown as number]) {
      _resetAuthForTests();
      const spy = exchangeReturns({ data: { accessToken: 'tok', expiresIn: bad } });
      await getAuthToken();
      await getAuthToken();
      expect({ bad, exchanges: spy.mock.calls.length }).toEqual({ bad, exchanges: 1 });
    }
  });
});

describe('invalidateCredential', () => {
  it('drops the KEY as well as the token, so a rotated secret is re-read', async () => {
    // The token-renew Lambda rotates the secret underneath a warm container.
    // Re-exchanging alone would keep presenting the retired key forever.
    process.env.PLATFORM_SECRET_NAME = 'pb/platform';
    delete process.env.PLATFORM_ACCESS_KEY;
    mockSend.mockResolvedValue({ SecretString: JSON.stringify({ password: 'pb_sa_first' }) });
    exchangeReturns({ data: { accessToken: 'a', expiresIn: 300 } });
    await getAuthToken();
    expect(mockSend).toHaveBeenCalledTimes(1);

    invalidateCredential();
    mockSend.mockResolvedValue({ SecretString: JSON.stringify({ password: 'pb_sa_rotated' }) });
    const spy = exchangeReturns({ data: { accessToken: 'b', expiresIn: 300 } });
    await expect(getAuthToken()).resolves.toBe('b');
    // The secret was read AGAIN, and the rotated key is what was exchanged.
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[0]?.[1] && (spy.mock.calls[0][1] as { body: string }).body))
      .toContain('pb_sa_rotated');
    delete process.env.PLATFORM_SECRET_NAME;
  });
});
