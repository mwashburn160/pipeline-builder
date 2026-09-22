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

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ApiError } from '../src/types/error.js';
import type { ApiClient } from '../src/utils/api-client.js';
import { provisionServiceAccountKey, revokeServiceAccountKey } from '../src/utils/service-account.js';

interface Recorded { url: string; body?: unknown; headers?: Record<string, string> }

/** A stub ApiClient recording every call, with per-route canned responses. */
function makeClient(routes: {
  organization?: unknown;
  roles?: unknown;
  accounts?: unknown[];
  createAccount?: () => unknown;
  createKey?: () => unknown;
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
        return routes.roles ?? { data: { roles: [{ id: 'role-admin', grantsRole: 'admin' }] } };
      }
      if (url.endsWith('/service-accounts')) return { data: { serviceAccounts: accounts } };
      throw new Error(`unexpected GET ${url}`);
    }),
    post: jest.fn(async (url: string, body?: unknown, headers?: Record<string, string>) => {
      posts.push({ url, body, headers });
      if (url === '/api/auth/step-up') return { data: { stepUpToken: `step-${posts.length}` } };
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
  password: 'hunter2',
  accountName: 'reporting-ingest',
  description: 'ingest',
  roles: 'none' as const,
  expiresInSeconds: 2_592_000,
  keyName: 'reporting-ingest-2026-03-15',
};

describe('provisionServiceAccountKey', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('creates the account and issues the key, step-up gating BOTH writes', async () => {
    const { client, posts } = makeClient({});
    const result = await provisionServiceAccountKey({ client, ...BASE, scope: 'reporting:ingest' });

    expect(result).toMatchObject({
      key: 'pb_sa_newkey',
      keyId: 'key-1',
      serviceAccountId: 'sa-1',
      serviceAccountName: 'reporting-ingest',
      organizationId: 'acme',
    });

    // Each gated write is preceded by its OWN step-up (single-use, ~60s).
    const gated = posts.filter((p) => p.url !== '/api/auth/step-up');
    expect(gated.map((p) => p.url)).toEqual([
      '/api/organization/acme/service-accounts',
      '/api/organization/acme/service-accounts/sa-1/keys',
    ]);
    for (const call of gated) expect(call.headers?.['X-Step-Up-Token']).toMatch(/^step-/);
    expect(posts.filter((p) => p.url === '/api/auth/step-up')).toHaveLength(2);
  });

  it('gives a SCOPED credential no roles at all, and stamps the scope on the key', async () => {
    const { client, posts } = makeClient({});
    await provisionServiceAccountKey({ client, ...BASE, roles: 'none', scope: 'registry:push' });

    const create = posts.find((p) => p.url.endsWith('/service-accounts'))!;
    expect((create.body as { roleIds: string[] }).roleIds).toEqual([]);
    const key = posts.find((p) => p.url.endsWith('/keys'))!;
    expect(key.body).toMatchObject({ scope: 'registry:push', expiresIn: BASE.expiresInSeconds });
  });

  it('grants the org admin role only to the UNSCOPED platform credential', async () => {
    const { client, posts } = makeClient({
      roles: { data: { roles: [{ id: 'role-admin', grantsRole: 'admin' }, { id: 'role-super', grantsRole: 'superadmin' }] } },
    });
    await provisionServiceAccountKey({ client, ...BASE, accountName: 'platform-automation', roles: 'admin' });

    const create = posts.find((p) => p.url.endsWith('/service-accounts'))!;
    // Superadmin wins where the org has one (the system org) — the ceiling on
    // the platform side still refuses it if the operator doesn't hold it.
    expect((create.body as { roleIds: string[] }).roleIds).toEqual(['role-super']);
    // …and a scoped key never sends a `scope` it wasn't given.
    expect(posts.find((p) => p.url.endsWith('/keys'))!.body).not.toHaveProperty('scope');
  });

  it('REUSES an existing account rather than creating a second one (idempotent re-run)', async () => {
    const { client, posts } = makeClient({ accounts: [{ id: 'sa-existing', name: 'reporting-ingest', keys: [] }] });
    const result = await provisionServiceAccountKey({ client, ...BASE });

    expect(result.serviceAccountId).toBe('sa-existing');
    expect(posts.some((p) => p.url === '/api/organization/acme/service-accounts')).toBe(false);
    // Only ONE step-up: the key issue. Reusing an account is not a write.
    expect(posts.filter((p) => p.url === '/api/auth/step-up')).toHaveLength(1);
  });

  it('resolves the 409 create race by looking the account up again', async () => {
    const { client } = makeClient({
      accounts: [],
      createAccount: () => { throw new ApiError('exists', 409, undefined); },
    });
    // The listing is re-read after the 409; the stub adds the account on create,
    // so simulate the concurrent winner by seeding it on the second read.
    const spy = client.get as unknown as jest.Mock<AnyFn>;
    let listReads = 0;
    const original = spy.getMockImplementation()!;
    spy.mockImplementation(async (url: string) => {
      if (url.endsWith('/service-accounts')) {
        listReads += 1;
        return { data: { serviceAccounts: listReads === 1 ? [] : [{ id: 'sa-raced', name: 'reporting-ingest' }] } };
      }
      return (original as (u: string) => Promise<unknown>)(url);
    });

    const result = await provisionServiceAccountKey({ client, ...BASE });
    expect(result.serviceAccountId).toBe('sa-raced');
  });

  it('self-heals past the active-key cap by retiring the OLDEST key, then retrying once', async () => {
    let attempts = 0;
    const { client, posts, deletes } = makeClient({
      accounts: [{
        id: 'sa-1',
        name: 'reporting-ingest',
        keys: [
          { id: 'key-new', status: 'active', createdAt: '2026-03-10T00:00:00Z' },
          { id: 'key-oldest', status: 'active', createdAt: '2026-01-01T00:00:00Z' },
          { id: 'key-revoked', status: 'revoked', createdAt: '2025-01-01T00:00:00Z' },
        ],
      }],
      createKey: () => {
        attempts += 1;
        if (attempts === 1) throw new ApiError('limit', 409, { data: { code: 'SA_KEY_LIMIT' } } as never);
        return { data: { key: 'pb_sa_newkey', accessKey: { id: 'key-2', expiresAt: '2026-04-01T00:00:00.000Z', scope: null } } };
      },
    });

    const result = await provisionServiceAccountKey({ client, ...BASE });
    expect(result.keyId).toBe('key-2');
    // The REVOKED key is never a candidate; the oldest ACTIVE one is.
    expect(deletes.map((d) => d.url)).toEqual(['/api/organization/acme/service-accounts/sa-1/keys/key-oldest']);
    expect(deletes[0]!.headers?.['X-Step-Up-Token']).toMatch(/^step-/);
    expect(posts.filter((p) => p.url.endsWith('/keys'))).toHaveLength(2);
  });

  it('re-raises a non-cap key failure instead of retiring someone else’s key', async () => {
    const { client, deletes } = makeClient({
      accounts: [{ id: 'sa-1', name: 'reporting-ingest', keys: [{ id: 'k', status: 'active', createdAt: '2026-01-01T00:00:00Z' }] }],
      createKey: () => { throw new ApiError('nope', 403, undefined); },
    });
    await expect(provisionServiceAccountKey({ client, ...BASE })).rejects.toThrow('nope');
    expect(deletes).toHaveLength(0);
  });

  it('explains a failed step-up rather than surfacing a bare 401', async () => {
    const { client } = makeClient({});
    (client.post as unknown as jest.Mock<AnyFn>).mockImplementation(async (url: string) => {
      if (url === '/api/auth/step-up') throw new ApiError('Invalid password', 401, undefined);
      throw new Error('should not get here');
    });
    await expect(provisionServiceAccountKey({ client, ...BASE }))
      .rejects.toThrow(/step-up.*PLATFORM_PASSWORD/s);
  });

  it('refuses to guess when the platform reports no active organization', async () => {
    const { client } = makeClient({ organization: { data: {} } });
    await expect(provisionServiceAccountKey({ client, ...BASE })).rejects.toThrow(/active organization/);
  });

  it('refuses to create a full-privilege account in an org with no admin role', async () => {
    const { client } = makeClient({ roles: { data: { roles: [{ id: 'r', grantsRole: 'member' }] } } });
    await expect(provisionServiceAccountKey({ client, ...BASE, roles: 'admin' })).rejects.toThrow(/no admin role/);
  });
});

describe('revokeServiceAccountKey', () => {
  it('step-up gates the revoke, like every other key write', async () => {
    const { client, deletes, posts } = makeClient({});
    await revokeServiceAccountKey(client, 'hunter2', 'acme', 'sa-1', 'key-old');
    expect(deletes[0]!.url).toBe('/api/organization/acme/service-accounts/sa-1/keys/key-old');
    expect(deletes[0]!.headers?.['X-Step-Up-Token']).toMatch(/^step-/);
    expect(posts.filter((p) => p.url === '/api/auth/step-up')).toHaveLength(1);
  });
});
