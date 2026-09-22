// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The scheduled KEY ROTATOR (#N2).
 *
 * The behaviour worth testing is not "does it rotate" but the ORDER, because
 * the order is what guarantees the deployment always holds a working
 * credential: rotate (old key stays live) → store → revoke the predecessor. Each
 * failure case below asserts what survives, not just that something threw.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockSend = jest.fn<(cmd: { __type: string; input: Record<string, unknown> }) => Promise<unknown>>();

jest.unstable_mockModule('@aws-sdk/client-secrets-manager', () => ({
  __esModule: true,
  SecretsManagerClient: class { send = mockSend; },
  GetSecretValueCommand: class { __type = 'Get'; constructor(public input: Record<string, unknown>) {} },
  PutSecretValueCommand: class { __type = 'Put'; constructor(public input: Record<string, unknown>) {} },
}));

const { handler } = await import('../src/lambda/token-renew-handler.js');

const OLD_KEY = 'pb_sa_1111111111111111111111111111aaaa';
const NEW_KEY = 'pb_sa_2222222222222222222222222222bbbb';

const STORED = {
  username: 'acme',
  password: OLD_KEY,
  platformUrl: 'https://pipeline-builder.com',
  organizationId: 'acme',
  serviceAccountId: 'sa-1',
  serviceAccountName: 'reporting-ingest',
  keyId: 'key-old',
  scope: 'reporting:ingest',
  expiresAt: '2026-04-01T00:00:00.000Z',
};

const ENV = {
  PLATFORM_SECRET_NAME: 'pipeline-builder/acme/reporting-ingest',
  RENEW_DAYS: '30',
  AWS_REGION: 'us-east-1',
};

/** Every fetch the handler made, as `[url, parsedBody]`. */
const mockFetch = jest.fn<(url: string, opts: { body: string }) => Promise<unknown>>();
const calls = () => mockFetch.mock.calls.map(([url, opts]) => [url, JSON.parse(opts.body)] as [string, Record<string, unknown>]);
/** The SecretString of the PutSecretValue call, or undefined if there was none. */
function storedSecret(): Record<string, unknown> | undefined {
  const put = mockSend.mock.calls.find(([cmd]) => cmd.__type === 'Put');
  return put ? JSON.parse(put[0].input.SecretString as string) : undefined;
}

function okRotate(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 201,
    json: () => Promise.resolve({
      success: true,
      data: { key: NEW_KEY, keyId: 'key-new', expiresAt: '2026-05-01T00:00:00.000Z', prunedKeyIds: [], ...over },
    }),
  };
}
const okRevoke = { ok: true, status: 200, json: () => Promise.resolve({ success: true, data: { revoked: true } }) };

describe('token-renew-handler (key rotator)', () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = process.env;
    process.env = { ...saved, ...ENV };
    delete process.env.NODE_ENV;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    jest.clearAllMocks();
    mockSend.mockImplementation((cmd) => {
      if (cmd.__type === 'Get') return Promise.resolve({ SecretString: JSON.stringify(STORED) });
      return Promise.resolve({});
    });
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/auth/key/rotate')) return Promise.resolve(okRotate());
      if (url.includes('/auth/key/revoke')) return Promise.resolve(okRevoke);
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });
    global.fetch = mockFetch as unknown as typeof fetch;
  });
  afterEach(() => { process.env = saved; });

  it('rotates, stores, then revokes the predecessor — in that order', async () => {
    await handler();

    const [rotate, revoke] = calls();
    expect(rotate![0]).toBe('https://pipeline-builder.com/api/auth/key/rotate');
    // The ROTATE is authenticated with the key currently in the secret.
    expect(rotate![1].key).toBe(OLD_KEY);
    expect(rotate![1].expiresIn).toBe(30 * 24 * 60 * 60);

    // The REVOKE is authenticated with the NEW key and names the OLD key id —
    // never the other way round, which would retire the credential in use.
    expect(revoke![0]).toBe('https://pipeline-builder.com/api/auth/key/revoke');
    expect(revoke![1]).toEqual({ key: NEW_KEY, keyId: 'key-old' });

    // And the store happened BETWEEN them.
    const order = [
      ...mockFetch.mock.invocationCallOrder.map((n, i) => ({ n, what: i === 0 ? 'rotate' : 'revoke' })),
      ...mockSend.mock.calls.map((c, i) => ({ n: mockSend.mock.invocationCallOrder[i], what: c[0].__type })),
    ].sort((a, b) => a.n! - b.n!).map((e) => e.what);
    expect(order).toEqual(['Get', 'rotate', 'Put', 'revoke']);
  });

  it('writes the new key into the secret, preserving everything else', async () => {
    await handler();
    expect(storedSecret()).toMatchObject({
      username: 'acme',
      password: NEW_KEY,
      keyId: 'key-new',
      serviceAccountId: 'sa-1',
      serviceAccountName: 'reporting-ingest',
      scope: 'reporting:ingest',
      platformUrl: 'https://pipeline-builder.com',
      expiresAt: '2026-05-01T00:00:00.000Z',
      expiresIn: 30 * 24 * 60 * 60,
    });
  });

  it('ROTATE fails → the secret is untouched, so the live key keeps working', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/auth/key/rotate')) {
        return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ message: 'Invalid or revoked access key' }) });
      }
      return Promise.resolve(okRevoke);
    });

    await expect(handler()).rejects.toThrow(/rotation refused \(401\)/);
    expect(storedSecret()).toBeUndefined();
    expect(calls().some(([url]) => url.includes('/auth/key/revoke'))).toBe(false);
  });

  it('ROTATE returns no key → nothing is stored and nothing is revoked', async () => {
    mockFetch.mockImplementation((url: string) => (url.includes('/auth/key/rotate')
      ? Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ data: {} }) })
      : Promise.resolve(okRevoke)));

    await expect(handler()).rejects.toThrow(/no replacement key/);
    expect(storedSecret()).toBeUndefined();
    expect(calls()).toHaveLength(1);
  });

  it('STORE fails → the predecessor is NOT revoked, so the secret still names a live key', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd.__type === 'Get') return Promise.resolve({ SecretString: JSON.stringify(STORED) });
      return Promise.reject(new Error('PutSecretValue denied'));
    });

    await expect(handler()).rejects.toThrow(/PutSecretValue denied/);
    // The critical assertion: the old key is still valid because we never asked
    // the platform to retire it.
    expect(calls().some(([url]) => url.includes('/auth/key/revoke'))).toBe(false);
  });

  it('REVOKE fails → the rotation still SUCCEEDS (the credential is healthy) and logs the stale key', async () => {
    const errors: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((line) => { errors.push(String(line)); });
    mockFetch.mockImplementation((url: string) => (url.includes('/auth/key/rotate')
      ? Promise.resolve(okRotate())
      : Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ message: 'boom' }) })));

    // No throw: retrying would rotate a SECOND time and churn keys for nothing.
    await expect(handler()).resolves.toBeUndefined();
    expect(storedSecret()).toMatchObject({ password: NEW_KEY, keyId: 'key-new' });
    expect(errors.join('\n')).toMatch(/could NOT revoke its predecessor/);
    expect(errors.join('\n')).toContain('key-old');
    spy.mockRestore();
  });

  it('a revoke that cannot even be reached is treated the same way (no throw)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockImplementation((url: string) => (url.includes('/auth/key/rotate')
      ? Promise.resolve(okRotate())
      : Promise.reject(new Error('platform unreachable'))));
    await expect(handler()).resolves.toBeUndefined();
    expect(storedSecret()).toMatchObject({ password: NEW_KEY });
    spy.mockRestore();
  });

  it('skips the revoke when the secret records no previous key id', async () => {
    const { keyId: _drop, ...noKeyId } = STORED;
    mockSend.mockImplementation((cmd) => (cmd.__type === 'Get'
      ? Promise.resolve({ SecretString: JSON.stringify(noKeyId) })
      : Promise.resolve({})));
    await handler();
    expect(storedSecret()).toMatchObject({ password: NEW_KEY });
    expect(calls().some(([url]) => url.includes('/auth/key/revoke'))).toBe(false);
  });

  it('reads the platform URL recorded IN the secret (the only source)', async () => {
    mockSend.mockImplementation((cmd) => (cmd.__type === 'Get'
      ? Promise.resolve({ SecretString: JSON.stringify({ ...STORED, platformUrl: 'https://other.example.com' }) })
      : Promise.resolve({})));
    await handler();
    expect(calls()[0]![0]).toBe('https://other.example.com/api/auth/key/rotate');
  });

  it('throws when the secret records no platformUrl', async () => {
    const { platformUrl: _drop, ...noUrl } = STORED;
    mockSend.mockImplementation((cmd) => (cmd.__type === 'Get'
      ? Promise.resolve({ SecretString: JSON.stringify(noUrl) })
      : Promise.resolve({})));
    await expect(handler()).rejects.toThrow(/missing platformUrl/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('REFUSES a secret still holding a pre-cutover JWT, naming the fix', async () => {
    mockSend.mockImplementation((cmd) => (cmd.__type === 'Get'
      ? Promise.resolve({ SecretString: JSON.stringify({ ...STORED, password: 'header.payload.sig' }) })
      : Promise.resolve({})));
    await expect(handler()).rejects.toThrow(/store-token/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws when the secret has no credential at all', async () => {
    mockSend.mockImplementation((cmd) => (cmd.__type === 'Get'
      ? Promise.resolve({ SecretString: JSON.stringify({ username: 'acme' }) })
      : Promise.resolve({})));
    await expect(handler()).rejects.toThrow(/missing password/);
  });

  it('throws when a required env var is missing', async () => {
    delete process.env.PLATFORM_SECRET_NAME;
    await expect(handler()).rejects.toThrow(/PLATFORM_SECRET_NAME/);
  });

  it('rejects an out-of-range RENEW_DAYS instead of asking for a key that cannot be issued', async () => {
    process.env.RENEW_DAYS = '400';
    await expect(handler()).rejects.toThrow(/RENEW_DAYS/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('honors PLATFORM_VERIFY_SSL=false outside production, and REFUSES it in production', async () => {
    process.env.PLATFORM_VERIFY_SSL = 'false';
    await handler();
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0');

    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_ENV = 'production';
    await handler();
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it('surfaces keys the platform pruned to stay under the active-key cap', async () => {
    const warnings: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((line) => { warnings.push(String(line)); });
    mockFetch.mockImplementation((url: string) => (url.includes('/auth/key/rotate')
      ? Promise.resolve(okRotate({ prunedKeyIds: ['key-ancient'] }))
      : Promise.resolve(okRevoke)));
    await handler();
    expect(warnings.join('\n')).toContain('key-ancient');
    spy.mockRestore();
  });
});
