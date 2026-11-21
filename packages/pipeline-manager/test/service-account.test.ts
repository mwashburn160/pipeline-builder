// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The CLI's service-account provisioning — what `store-token` uses to turn
 * "store a credential" into "give the org a machine identity and issue it a key".
 *
 * The behaviours that matter here are the ones an operator gets wrong or that
 * silently weaken the credential: the step-up every write needs, reusing an
 * existing account instead of duplicating it, granting NO roles to a scoped key,
 * and self-healing past the active-key cap.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { ApiError } from '../src/types/error.js';
import type { ApiClient } from '../src/utils/api-client.js';
import { adoptServiceAccountKey, browserStepUp, passwordStepUp, provisionServiceAccountKey, revokeServiceAccountKey, totpStepUp } from '../src/utils/service-account.js';

interface Recorded { url: string; body?: unknown; headers?: Record<string, string> }

/** A stub ApiClient recording every call, with per-route canned responses. */
function makeClient(routes: {
  organization?: unknown;
  roles?: unknown;
  accounts?: unknown[];
  createAccount?: () => unknown;
  createKey?: () => unknown;
  /** `POST …/provision-key`. Default: 404. */
  provisionKey?: (body: unknown) => unknown;
}) {
  const posts: Recorded[] = [];
  const gets: Recorded[] = [];
  const deletes: Recorded[] = [];
  let accounts = routes.accounts ?? [];

  const client = {
    getBaseUrl: () => 'https://pb.example.com',
    get: jest.fn(async (url: string) => {
      gets.push({ url });
      if (url === '/api/organization') return routes.organization ?? { data: { organization: { id: 'acme' } } };
      if (url.endsWith('/roles')) {
        return routes.roles ?? {
          data: {
            roles: [
              { id: 'role-admin', name: 'Admin', grantsRole: 'admin', system: true },
              { id: 'role-pa', name: 'Pipeline Automation', grantsRole: 'member', system: true },
              { id: 'role-pr', name: 'Pipeline Registration', grantsRole: 'member', system: true },
            ],
          },
        };
      }
      if (url.endsWith('/service-accounts')) return { data: { serviceAccounts: accounts } };
      throw new Error(`unexpected GET ${url}`);
    }),
    post: jest.fn(async (url: string, body?: unknown, headers?: Record<string, string>) => {
      posts.push({ url, body, headers });
      if (url === '/api/auth/step-up') return { data: { stepUpToken: `step-${posts.length}` } };
      if (url.endsWith('/provision-key')) {
        if (!routes.provisionKey) throw new ApiError('Not Found', 404, undefined);
        return routes.provisionKey(body);
      }
      if (url.endsWith('/keys')) {
        return (routes.createKey ?? (() => ({ data: { key: 'pb_sa_newkey', accessKey: { id: 'key-1', expiresAt: '2026-04-01T00:00:00.000Z', scope: null } } })))();
      }
      if (url.endsWith('/service-accounts')) {
        const made = (routes.createAccount ?? (() => ({ data: { serviceAccount: { id: 'sa-1' } } })))();
        accounts = [...accounts, { id: 'sa-1', name: (body as { name: string }).name, keys: [] }];
        return made;
      }
      throw new Error(`unexpected POST ${url}`);
    }),
    delete: jest.fn(async (url: string, headers?: Record<string, string>) => {
      deletes.push({ url, headers });
      return { data: { revoked: true } };
    }),
  };
  return { client: client as unknown as ApiClient, posts, gets, deletes };
}

const BASE = {
  accountName: 'reporting-ingest',
  description: 'ingest',
  expiresInSeconds: 2_592_000,
  keyName: 'reporting-ingest-2026-03-15',
};

describe('provisionServiceAccountKey', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('ONE call and ONE step-up on a platform with provision-key (passwordless approvals cost one prompt)', async () => {
    let sent: unknown;
    const { client, posts } = makeClient({
      provisionKey: (body) => {
        sent = body;
        return { data: { organizationId: 'acme', serviceAccount: { id: 'sa-9', name: 'reporting-ingest', created: true }, key: 'pb_sa_one', accessKey: { id: 'key-9', expiresAt: '2026-12-01T00:00:00.000Z', scope: 'reporting:ingest' }, retiredKeyIds: [] } };
      },
    });
    const stepUp = jest.fn(async () => 'tok-1');
    const result = await provisionServiceAccountKey({ client, stepUp, ...BASE, scope: 'reporting:ingest' });
    expect(stepUp).toHaveBeenCalledTimes(1);
    const gated = posts.filter((p) => p.url.endsWith('/provision-key'));
    expect(gated).toHaveLength(1);
    expect(gated[0]!.headers?.['X-Step-Up-Token']).toBe('tok-1');
    expect(posts.some((p) => p.url.endsWith('/service-accounts') || p.url.endsWith('/keys'))).toBe(false);
    expect(sent).toEqual({
      accountName: 'reporting-ingest',
      description: 'ingest',
      scope: 'reporting:ingest',
      key: { name: BASE.keyName, expiresIn: BASE.expiresInSeconds },
    });
    expect(result).toEqual({
      key: 'pb_sa_one',
      keyId: 'key-9',
      serviceAccountId: 'sa-9',
      serviceAccountName: 'reporting-ingest',
      organizationId: 'acme',
      expiresAt: '2026-12-01T00:00:00.000Z',
      scope: 'reporting:ingest',
    });
  });

  it('sends the role (never a scope) for the platform credential via provision-key', async () => {
    let sent: Record<string, unknown> = {};
    const { client } = makeClient({
      provisionKey: (body) => {
        sent = body as Record<string, unknown>;
        return { data: { serviceAccount: { id: 'sa-p', name: 'platform-automation', created: false }, key: 'k', accessKey: { id: 'i', expiresAt: 'x', scope: null } } };
      },
    });
    await provisionServiceAccountKey({ client, stepUp: async () => 't', ...BASE, accountName: 'platform-automation', role: 'pipeline_automation' });
    expect(sent.role).toBe('pipeline_automation');
    expect(sent).not.toHaveProperty('scope');
  });

  it('a provision-key failure is raised', async () => {
    const { client, posts } = makeClient({ provisionKey: () => { throw new ApiError('forbidden', 403, undefined); } });
    await expect(provisionServiceAccountKey({ client, stepUp: async () => 't', ...BASE })).rejects.toThrow('forbidden');
    expect(posts.some((p) => p.url.endsWith('/keys'))).toBe(false);
  });

  it('a 404 from provision-key is raised: there is no per-step path', async () => {
    const { client, posts } = makeClient({});
    await expect(provisionServiceAccountKey({ client, stepUp: async () => 't', ...BASE })).rejects.toThrow('Not Found');
    expect(posts.some((p) => p.url.endsWith('/service-accounts') || p.url.endsWith('/keys'))).toBe(false);
  });

  it('reports a key the platform retired at the active-key cap', async () => {
    const { client } = makeClient({
      provisionKey: () => ({ data: { serviceAccount: { id: 'sa-1', name: 'reporting-ingest', created: false }, key: 'k', accessKey: { id: 'key-2', expiresAt: 'x', scope: null }, retiredKeyIds: ['key-oldest'] } }),
    });
    const result = await provisionServiceAccountKey({ client, stepUp: async () => 't', ...BASE });
    expect(result).toMatchObject({ keyId: 'key-2', serviceAccountId: 'sa-1' });
  });

  it('explains a failed step-up rather than surfacing a bare 401', async () => {
    const { client } = makeClient({});
    (client.post as unknown as jest.Mock<AnyFn>).mockImplementation(async (url: string) => {
      if (url === '/api/auth/step-up') throw new ApiError('Invalid password', 401, undefined);
      throw new Error('should not get here');
    });
    await expect(provisionServiceAccountKey({ client, stepUp: passwordStepUp(client, 'hunter2'), ...BASE }))
      .rejects.toThrow(/step-up.*PLATFORM_PASSWORD/s);
  });

  it('refuses to guess when the platform reports no active organization', async () => {
    const { client } = makeClient({ organization: { data: {} } });
    await expect(provisionServiceAccountKey({ client, stepUp: passwordStepUp(client, 'hunter2'), ...BASE })).rejects.toThrow(/active organization/);
  });
});

describe('revokeServiceAccountKey', () => {
  it('step-up gates the revoke, like every other key write', async () => {
    const { client, deletes, posts } = makeClient({});
    await revokeServiceAccountKey(client, passwordStepUp(client, 'hunter2'), 'acme', 'sa-1', 'key-old');
    expect(deletes[0]!.url).toBe('/api/organization/acme/service-accounts/sa-1/keys/key-old');
    expect(deletes[0]!.headers?.['X-Step-Up-Token']).toMatch(/^step-/);
    expect(posts.filter((p) => p.url === '/api/auth/step-up')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// store-token --from-key: adopting a key issued in the web UI (no password).
// ---------------------------------------------------------------------------

describe('adoptServiceAccountKey', () => {
  const ACCOUNTS = [
    { id: 'sa-ingest', name: 'reporting-ingest', keys: [{ id: 'k-pasted', status: 'active', createdAt: '2026-11-01', scope: 'reporting:ingest' }] },
    { id: 'sa-plat', name: 'platform-automation', keys: [{ id: 'k-plat', status: 'active', createdAt: '2026-11-01', scope: null }] },
  ];
  function adoptClient(exchangeKeyId = 'k-pasted') {
    const posts: Recorded[] = [];
    const client = {
      getBaseUrl: () => 'https://pb.example.com',
      get: jest.fn(async (url: string) => {
        if (url === '/api/organization') return { data: { organization: { id: 'acme' } } };
        if (url.endsWith('/service-accounts')) return { data: { serviceAccounts: ACCOUNTS } };
        throw new Error(`unexpected GET ${url}`);
      }),
      post: jest.fn(async (url: string, body?: unknown, headers?: Record<string, string>) => {
        posts.push({ url, body, headers });
        if (url === '/api/auth/token/exchange') return { data: { accessToken: 't', expiresIn: 300, keyId: exchangeKeyId } };
        if (url === '/api/auth/key/rotate') return { data: { key: 'pb_sa_fresh', keyId: 'k-fresh', previousKeyId: 'k-pasted', expiresAt: '2026-12-18T00:00:00.000Z', scope: 'reporting:ingest' } };
        if (url === '/api/auth/key/revoke') return { data: { revoked: true } };
        throw new Error(`unexpected POST ${url}`);
      }),
      delete: jest.fn(),
    };
    return { client: client as unknown as ApiClient, posts };
  }
  const OPTS = { rawKey: 'pb_sa_pasted', accountName: 'reporting-ingest', scope: 'reporting:ingest', expiresInSeconds: 2_592_000, keyName: 'reporting-ingest-2026-11-18' };

  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); });

  it('verifies, rotates and retires the pasted key — with NO step-up anywhere', async () => {
    const { client, posts } = adoptClient();
    const got = await adoptServiceAccountKey({ client, ...OPTS });
    expect(posts.map((p) => p.url)).toEqual(['/api/auth/token/exchange', '/api/auth/key/rotate', '/api/auth/key/revoke']);
    expect(posts.some((p) => p.url === '/api/auth/step-up' || p.headers?.['X-Step-Up-Token'])).toBe(false);
    expect(posts[1]!.body).toEqual({ key: 'pb_sa_pasted', name: OPTS.keyName, expiresIn: OPTS.expiresInSeconds });
    // The pasted key is retired BY the fresh one.
    expect(posts[2]!.body).toEqual({ key: 'pb_sa_fresh', keyId: 'k-pasted' });
    // What is stored is the fresh key, never the pasted string.
    expect(got).toEqual({
      key: 'pb_sa_fresh',
      keyId: 'k-fresh',
      serviceAccountId: 'sa-ingest',
      serviceAccountName: 'reporting-ingest',
      organizationId: 'acme',
      expiresAt: '2026-12-18T00:00:00.000Z',
      scope: 'reporting:ingest',
    });
  });

  it('refuses a key on the WRONG account before minting anything', async () => {
    const { client, posts } = adoptClient('k-plat');
    await expect(adoptServiceAccountKey({ client, ...OPTS })).rejects.toThrow(/'platform-automation'.*must be on 'reporting-ingest'/);
    expect(posts.map((p) => p.url)).toEqual(['/api/auth/token/exchange']);
  });

  it('refuses an unscoped key as the ingest credential (the silent-403 case)', async () => {
    const { client, posts } = adoptClient('k-plat');
    await expect(adoptServiceAccountKey({ client, ...OPTS, accountName: 'platform-automation' })).rejects.toThrow(/carries no scope.*'reporting:ingest'/);
    expect(posts.map((p) => p.url)).not.toContain('/api/auth/key/rotate');
  });

  it('refuses a key from another organization', async () => {
    const { client } = adoptClient('k-elsewhere');
    await expect(adoptServiceAccountKey({ client, ...OPTS })).rejects.toThrow(/does not belong to a service account in your active organization/);
  });

  it('refuses something that is not a service-account key, naming where to get one', async () => {
    const { client, posts } = adoptClient();
    await expect(adoptServiceAccountKey({ client, ...OPTS, rawKey: 'pb_pat_personal' })).rejects.toThrow(/expected pb_sa_/);
    expect(posts).toHaveLength(0);
  });

  it('explains a refused key instead of surfacing a bare 401', async () => {
    const { client } = adoptClient();
    (client.post as jest.Mock).mockImplementationOnce(async () => { throw new Error('401 Unauthorized'); });
    await expect(adoptServiceAccountKey({ client, ...OPTS })).rejects.toThrow(/refused the key.*revoked or expired/);
  });

  it('a failed retire of the pasted key only warns — the fresh key is already minted', async () => {
    const { client } = adoptClient();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const post = client.post as jest.Mock<AnyFn>;
    const real = post.getMockImplementation()!;
    post.mockImplementation(async (url: unknown, ...rest: unknown[]) => {
      if (url === '/api/auth/key/revoke') throw new Error('boom');
      return real(url, ...rest);
    });
    await expect(adoptServiceAccountKey({ client, ...OPTS })).resolves.toMatchObject({ key: 'pb_sa_fresh' });
    expect(warn.mock.calls.flat().join(' ')).toContain('Could not retire the pasted key (k-pasted)');
  });
});

describe('step-up providers', () => {
  it('totpStepUp posts the code (spaces stripped) to /auth/step-up/totp, once per token', async () => {
    const post = jest.fn(async (..._a: unknown[]) => ({ data: { stepUpToken: 'tok-totp' } }));
    const client = { post } as unknown as ApiClient;
    const ask = jest.fn(async () => '123 456');
    await expect(totpStepUp(client, ask)()).resolves.toBe('tok-totp');
    expect(post).toHaveBeenCalledWith('/api/auth/step-up/totp', { code: '123456' });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('totpStepUp explains a refused code', async () => {
    const client = { post: jest.fn(async () => { throw new ApiError('Invalid code', 401, undefined); }) } as unknown as ApiClient;
    await expect(totpStepUp(client, async () => '000000')()).rejects.toThrow(/authenticator code was not accepted/);
  });

  it('browserStepUp returns the approval’s step-up token, and refuses an approval without one', async () => {
    await expect(browserStepUp(async () => 'tok-browser')()).resolves.toBe('tok-browser');
    await expect(browserStepUp(async () => undefined)()).rejects.toThrow(/did not return a step-up confirmation/);
  });
});
