// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Inherited (parent-admin) authority at the TOKEN chokepoint. A parent-org
 * admin who opens one of its teams has no membership row there; token issuance
 * must still scope the session to the team — as `admin`, carrying the parent
 * Roles' permissions — while anyone without that authority falls back exactly
 * as before. Exercised through `issueTokens` against an in-memory model layer.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { mockConfig } from './helpers/config-mock.js';
import { queryChain } from './helpers/query-chain.js';

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  auth: {
    passwordMinLength: 8,
    jwt: { secret: 'test-jwt-secret', expiresIn: 7200, algorithm: 'HS256', tierExpiresIn: {} },
    refreshToken: { secret: 'test-refresh-secret', expiresIn: 2592000 },
  },
}));
jest.unstable_mockModule('../src/helpers/mfa-policy.js', () => ({ resolveEffectiveMfaPolicy: async () => ({}) }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));

interface Org { _id: string; name: string; parentOrgId?: string | null; tier?: string; deletedAt?: Date | null; featureEntitlements?: string[] }
interface Membership { userId: string; organizationId: string; role: string; isActive: boolean; joinedAt: Date }

const orgs = new Map<string, Org>();
let memberships: Membership[] = [];
/** userId|orgId → permissions granted by that user's Roles in that org. */
const rolePerms = new Map<string, string[]>();

function matches(m: Membership, q: Record<string, any>): boolean {
  if (q.userId !== undefined && m.userId !== q.userId) return false;
  if (q.organizationId !== undefined && m.organizationId !== String(q.organizationId)) return false;
  if (q.isActive !== undefined && m.isActive !== q.isActive) return false;
  if (q.role?.$in && !q.role.$in.includes(m.role)) return false;
  return true;
}

jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {},
  UserPreferences: {},
  User: { updateOne: jest.fn(async () => ({})) },
  Organization: { findById: (id: string) => queryChain(orgs.get(String(id)) ?? null) },
  UserOrganization: {
    findOne: (q: Record<string, any>) => queryChain(memberships.find((m) => matches(m, q)) ?? null),
    find: (q: Record<string, any>) => queryChain(
      memberships.filter((m) => matches(m, q)).map((m) => ({ ...m, organizationId: { toString: () => m.organizationId } })),
    ),
  },
  RoleAssignment: {
    find: (q: { userId: string; organizationId: { $in: string[] } }) => queryChain(
      q.organizationId.$in
        .filter((org) => rolePerms.has(`${q.userId}|${org}`))
        .map((org) => ({ roleId: `${q.userId}|${org}` })),
    ),
  },
  Role: {
    find: (q: { _id: { $in: string[] } }) => queryChain(q._id.$in.map((id) => ({ permissions: rolePerms.get(id) ?? [] }))),
  },
}));

const { signInAuth } = await import('../src/services/session/access-tokens.js');
const { issueTokens } = await import('../src/services/session/refresh-sessions.js');
const { installTestSigningKeys } = await import('./helpers/signing.js');
installTestSigningKeys();

const login = { kind: 'interactive' as const, auth: signInAuth('pwd') };
const user = (id: string) => ({ _id: { toString: () => id }, username: id, email: `${id}@x.com`, isEmailVerified: true, tokenVersion: 1 }) as any;
const claims = (token: string) => jwt.decode(token) as Record<string, any>;
const joined = new Date(0);

beforeEach(() => {
  orgs.clear();
  rolePerms.clear();
  orgs.set('root', { _id: 'root', name: 'Root', tier: 'team', parentOrgId: null });
  orgs.set('team', { _id: 'team', name: 'Blue team', tier: 'team', parentOrgId: 'root' });
  memberships = [];
});

describe('issueTokens — admin authority inherited from a parent org', () => {
  it('scopes a parent admin into a team with NO membership row, as admin, with the parent Roles\' permissions', async () => {
    memberships = [{ userId: 'boss', organizationId: 'root', role: 'owner', isActive: true, joinedAt: joined }];
    rolePerms.set('boss|root', ['org:settings', 'members:manage']);

    const { accessToken } = await issueTokens(user('boss'), 'team', login);
    const c = claims(accessToken);

    expect(c.organizationId).toBe('team');
    expect(c.organizationName).toBe('Blue team');
    // Inherited authority is ADMIN — ownership is never conferred downward.
    expect(c.role).toBe('admin');
    expect(c.isAdmin).toBe(true);
    expect(c.permissions).toEqual(expect.arrayContaining(['org:settings', 'members:manage']));
    expect(c.parentOrganizationId).toBe('root');
    expect(c.rootOrganizationId).toBe('root');
  });

  it('does not let a plain member of the parent into the team — falls back to their own org', async () => {
    memberships = [{ userId: 'pleb', organizationId: 'root', role: 'member', isActive: true, joinedAt: joined }];

    const { accessToken } = await issueTokens(user('pleb'), 'team', login);
    const c = claims(accessToken);

    expect(c.organizationId).toBe('root');
    expect(c.role).toBe('member');
  });

  it('an inherited admin outranks a plain-member row in the team; permissions are the union', async () => {
    memberships = [
      { userId: 'boss', organizationId: 'root', role: 'admin', isActive: true, joinedAt: joined },
      { userId: 'boss', organizationId: 'team', role: 'member', isActive: true, joinedAt: joined },
    ];
    rolePerms.set('boss|root', ['org:settings']);
    rolePerms.set('boss|team', ['pipelines:read']);

    const c = claims((await issueTokens(user('boss'), 'team', login)).accessToken);

    expect(c.organizationId).toBe('team');
    expect(c.role).toBe('admin');
    expect(c.permissions).toEqual(expect.arrayContaining(['org:settings', 'pipelines:read']));
  });

  it('a direct admin/owner row in the team wins as-is (no inheritance needed)', async () => {
    memberships = [{ userId: 'lead', organizationId: 'team', role: 'owner', isActive: true, joinedAt: joined }];
    rolePerms.set('lead|team', ['org:settings']);

    const c = claims((await issueTokens(user('lead'), 'team', login)).accessToken);

    expect(c.organizationId).toBe('team');
    expect(c.role).toBe('owner');
  });

  it('confers nothing from an INACTIVE parent membership or a SOFT-DELETED parent', async () => {
    memberships = [{ userId: 'boss', organizationId: 'root', role: 'owner', isActive: false, joinedAt: joined }];
    expect(claims((await issueTokens(user('boss'), 'team', login)).accessToken).organizationId).toBeUndefined();

    memberships = [{ userId: 'boss', organizationId: 'root', role: 'owner', isActive: true, joinedAt: joined }];
    orgs.set('root', { ...orgs.get('root')!, deletedAt: new Date() });
    expect(claims((await issueTokens(user('boss'), 'team', login)).accessToken).organizationId).toBeUndefined();
  });

  it('never scopes into a SOFT-DELETED team, inherited authority or not', async () => {
    memberships = [{ userId: 'boss', organizationId: 'root', role: 'owner', isActive: true, joinedAt: joined }];
    orgs.set('team', { ...orgs.get('team')!, deletedAt: new Date() });

    const c = claims((await issueTokens(user('boss'), 'team', login)).accessToken);
    expect(c.organizationId).toBe('root');
  });
});
