// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Built-in Role permissions are resolved from the CATALOG at read time.
 *
 * A built-in (`system: true`) Role stores no permission list: what it grants is
 * `builtinRolePermissions(grantsRole, seedBundle)`, looked up on every sign-in,
 * token refresh and key exchange through `effectiveRolePermissions`. So a
 * release that changes a catalog bundle reaches every existing org on the next
 * token refresh — there is no seeded copy for it to miss, and no re-sync job.
 * A custom Role grants exactly its stored list.
 *
 * These drive the REAL minting path (`issueTokens` → membership resolution →
 * `rolePermissionsFor`) and the service-account exchange read
 * (`serviceAccountRolesFor`) with hand-written Role documents whose stored list
 * is empty or stale, and read the permissions back off the token.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  ROLE_PERMISSIONS, SEED_BUNDLES,
} from '@pipeline-builder/api-core';
import jwt from 'jsonwebtoken';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const SYSTEM = '000000000000000000000001';
const TENANT = 'aaaaaaaaaaaaaaaaaaaaaaaa';

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  auth: {
    jwt: { secret: 'test-secret', algorithm: 'HS256', expiresIn: 3600, tierExpiresIn: {} },
    refreshToken: { secret: 'test-refresh-secret', expiresIn: 86400 },
  },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ resolveUserFeatures: () => [] }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  isAncestorOrg: async () => false,
  resolveOrgLineage: async (orgId: string) => ({ rootOrgId: orgId }),
  getParentOrgId: async () => undefined,
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));

/** The Role documents the user (or service account) holds, as stored. */
let heldRoles: Array<Record<string, unknown>> = [];
const chain = (rows: () => unknown[]) => () => ({ session: () => ({ select: () => ({ lean: () => Promise.resolve(rows()) }) }) });

const { sessionStoreFake } = await import('./helpers/session-store-fake.js');
jest.unstable_mockModule('../src/services/session/session-store.js', () => sessionStoreFake());

jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {},
  UserPreferences: {},
  User: { updateOne: jest.fn(async () => ({})) },
  Organization: {
    findById: (id: string) => ({ select: () => ({ lean: () => Promise.resolve({ name: `org-${id}`, tier: 'team', parentOrgId: null, deletedAt: null }) }) }),
  },
  UserOrganization: {
    findOne: () => ({ lean: () => Promise.resolve({ role: 'member' }) }),
    find: () => ({ sort: () => ({ lean: () => Promise.resolve([]) }) }),
  },
  Role: { find: chain(() => heldRoles) },
  RoleAssignment: {
    find: chain(() => heldRoles.map((r) => ({ roleId: r._id, serviceAccountId: 'sa-1' }))),
  },
}));

const { signInAuth } = await import('../src/services/session/access-tokens.js');
const { issueTokens } = await import('../src/services/session/refresh-sessions.js');
const { serviceAccountRolesFor } = await import('../src/services/service-account-roles.js');
const { installTestSigningKeys } = await import('./helpers/signing.js');
installTestSigningKeys();

const user = {
  _id: { toString: () => 'user-1' },
  username: 'u',
  email: 'u@example.com',
  isEmailVerified: true,
  tokenVersion: 1,
} as unknown as Parameters<typeof issueTokens>[0];

const tokenPermissions = async (orgId: string): Promise<string[]> => {
  const { accessToken } = await issueTokens(user, orgId, { kind: 'interactive', auth: signInAuth('pwd') });
  return [...(jwt.decode(accessToken) as { permissions: string[] }).permissions].sort();
};
const sorted = (xs: readonly string[]) => [...xs].sort();

beforeEach(() => {
  heldRoles = [];
});

describe('a minted token resolves a built-in Role from the catalog', () => {
  it('a built-in Member Role that stores NOTHING still grants the catalog member bundle', async () => {
    heldRoles = [{ _id: 'r-member', name: 'Member', grantsRole: 'member', system: true, permissions: [] }];
    expect(await tokenPermissions(TENANT)).toEqual(sorted(ROLE_PERMISSIONS.member));
  });

  it('a built-in Role with a STALE stored list grants the catalog bundle, not the stale copy', async () => {
    // A copy from an older catalog: missing most of today's bundle, and
    // carrying one permission the Member bundle does not grant.
    heldRoles = [{
      _id: 'r-member', name: 'Member', grantsRole: 'member', system: true, permissions: ['pipelines:read', 'billing:manage'],
    }];
    const perms = await tokenPermissions(TENANT);
    expect(perms).toEqual(sorted(ROLE_PERMISSIONS.member));
    expect(perms).not.toContain('billing:manage');
  });

  it('a built-in job Role resolves its NAMED seed bundle, not the member bundle it shares grantsRole with', async () => {
    heldRoles = [{
      _id: 'r-pv', name: 'Publisher Verifier', grantsRole: 'member', seedBundle: 'publisher_verifier', system: true, permissions: [],
    }];
    expect(await tokenPermissions(SYSTEM)).toEqual(sorted(SEED_BUNDLES.publisher_verifier.permissions));
  });

  it('a built-in Admin Role grants the admin bundle', async () => {
    heldRoles = [{ _id: 'r-admin', name: 'Admin', grantsRole: 'admin', system: true, permissions: [] }];
    const perms = await tokenPermissions(TENANT);
    expect(perms).toContain('roles:manage');
    expect(perms).toContain('org_settings:write');
  });

  it('a CUSTOM Role grants exactly its stored list', async () => {
    heldRoles = [{ _id: 'r-custom', name: 'Billing', grantsRole: 'member', system: false, permissions: ['billing:read', 'billing:manage'] }];
    expect(await tokenPermissions(TENANT)).toEqual(['billing:manage', 'billing:read']);
  });

  it('unions a built-in and a custom Role', async () => {
    heldRoles = [
      { _id: 'r-member', name: 'Member', grantsRole: 'member', system: true, permissions: [] },
      { _id: 'r-custom', name: 'Billing', grantsRole: 'member', system: false, permissions: ['billing:manage'] },
    ];
    expect(await tokenPermissions(TENANT)).toEqual(sorted([...new Set([...ROLE_PERMISSIONS.member, 'billing:manage'])]));
  });
});

describe('a service account\'s exchange resolves a built-in Role from the catalog', () => {
  it('resolves a built-in machine Role with a stale stored list to its bundle; a custom Role to its list', async () => {
    heldRoles = [
      { _id: 'r-auto', name: 'Pipeline Automation', grantsRole: 'member', seedBundle: 'pipeline_automation', system: true, permissions: ['stale:perm'] },
      { _id: 'r-custom', name: 'Reader', grantsRole: 'member', system: false, permissions: ['pipelines:read'] },
    ];
    const held = (await serviceAccountRolesFor(TENANT, ['sa-1'])).get('sa-1')!;
    const byId = new Map(held.map((r) => [r.id, r.permissions]));
    expect(sorted(byId.get('r-auto')!)).toEqual(sorted(SEED_BUNDLES.pipeline_automation.permissions));
    expect(byId.get('r-custom')).toEqual(['pipelines:read']);
  });
});
