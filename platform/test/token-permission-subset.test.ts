// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalog-scoped credentials at the token layer: a permission SUBSET on a PAT
 * (or machine token) yields a token carrying subset ∩ the holder's CURRENT
 * permissions, with every claim that could bypass the subset (`isSuperAdmin`,
 * an admin `role`) forced down — and a scoped credential still carries none.
 */

import { jest, describe, it, expect } from '@jest/globals';

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    auth: {
      passwordMinLength: 8,
      jwt: { expiresIn: 900, tierExpiresIn: {} },
      refreshToken: { expiresIn: 2592000 },
    },
  },
}));

const emptyFindChain = () => ({ session: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) });
jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {},
  UserPreferences: {},
  User: { updateOne: jest.fn(async () => ({})) },
  Organization: {},
  UserOrganization: {},
  Role: { find: jest.fn(emptyFindChain) },
  RoleAssignment: { find: jest.fn(emptyFindChain) },
}));

const { signApiKeyToken, verifyAccessToken, signInAuth } = await import('../src/utils/token.js');
const { installTestSigningKeys } = await import('./helpers/signing.js');
installTestSigningKeys();

/* eslint-disable @typescript-eslint/no-explicit-any */
const user = (overrides: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'user-1' },
  username: 'holder',
  email: 'holder@example.com',
  isEmailVerified: true,
  tokenVersion: 3,
  ...overrides,
}) as any;

const membership = (rolePermissions: string[], role: 'owner' | 'admin' | 'member' = 'admin') => ({
  organizationId: 'org-1',
  organizationName: 'Acme',
  role,
  tier: 'pro' as const,
  rolePermissions,
});

async function claims(u: any, m: any, scope?: any, permissions?: string[]) {
  const token = await signApiKeyToken(u, m, 'key-1', signInAuth('pwd'), scope, permissions);
  return verifyAccessToken(token) as any;
}

describe('permission-scoped access tokens', () => {
  it('an unrestricted key carries the holder\'s full current permissions and role', async () => {
    const c = await claims(user(), membership(['pipelines:read', 'pipelines:write', 'org:settings']));
    expect(c.permissions).toEqual(['pipelines:read', 'pipelines:write', 'org:settings']);
    expect(c.role).toBe('admin');
    expect(c.permissionsRestricted).toBeUndefined();
  });

  it('a subset key carries subset ∩ current — never more than either', async () => {
    const c = await claims(
      user(),
      membership(['pipelines:read', 'pipelines:write', 'org:settings']),
      undefined,
      ['pipelines:read', 'billing:manage'],
    );
    // billing:manage is in the subset but the holder doesn't have it any more.
    expect(c.permissions).toEqual(['pipelines:read']);
    expect(c.permissionsRestricted).toBe(true);
  });

  it('losing a Role shrinks the key; nothing grows it', async () => {
    const before = await claims(user(), membership(['pipelines:read', 'plugins:read']), undefined, ['pipelines:read', 'plugins:read']);
    expect(before.permissions).toEqual(['pipelines:read', 'plugins:read']);
    const after = await claims(user(), membership(['plugins:read', 'org:settings', 'billing:manage']), undefined, ['pipelines:read', 'plugins:read']);
    expect(after.permissions).toEqual(['plugins:read']);
  });

  it('forces the claims that would bypass the subset down: no admin role, no superadmin', async () => {
    const c = await claims(user({ isSuperAdmin: true }), membership([], 'owner'), undefined, ['reports:read']);
    // A superadmin holds everything, so the subset is exactly what survives…
    expect(c.permissions).toEqual(['reports:read']);
    // …and the implicit-all flag and the admin role are gone.
    expect(c.isSuperAdmin).toBeUndefined();
    expect(c.role).toBe('member');
    expect(c.isAdmin).toBe(false);
  });

  it('an empty subset authenticates with no permissions at all', async () => {
    const c = await claims(user(), membership(['pipelines:read']), undefined, []);
    expect(c.permissions).toEqual([]);
    expect(c.permissionsRestricted).toBe(true);
  });

  it('a capability scope still wins: no permissions, and no restriction marker', async () => {
    const c = await claims(user(), membership(['pipelines:read']), 'reporting:ingest', ['pipelines:read']);
    expect(c.scope).toBe('reporting:ingest');
    expect(c.permissions).toEqual([]);
    expect(c.permissionsRestricted).toBeUndefined();
  });
});
