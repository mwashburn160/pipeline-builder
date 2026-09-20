// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The creation-time rules for a permission-scoped PAT / machine token
 * (`helpers/token-permissions.ts`): catalog ids only, at least one, ⊆ the
 * creator's CURRENT permissions (re-resolved, and bounded by the calling
 * token), never alongside a capability scope — and a restricted caller's "full
 * access" is its own current set.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

let storedUser: Record<string, unknown> | null = { _id: 'u1', lastActiveOrgId: 'org-1', isSuperAdmin: false };
let rolePermissions: string[] = [];
const mockMembershipForOrg = jest.fn(async () => ({ organizationId: 'org-1', role: 'member', rolePermissions }));

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findById: () => ({ select: () => ({ lean: async () => storedUser }) }) },
}));
jest.unstable_mockModule('../src/utils/token.js', () => ({ membershipForOrg: mockMembershipForOrg }));

const { callerRestriction, resolveRequestedPermissions } = await import('../src/helpers/token-permissions.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const req = (user: Record<string, unknown>) => ({ user }) as any;

beforeEach(() => {
  storedUser = { _id: 'u1', lastActiveOrgId: 'org-1', isSuperAdmin: false };
  rolePermissions = ['pipelines:read', 'pipelines:write', 'plugins:read'];
  mockMembershipForOrg.mockClear();
});

describe('resolveRequestedPermissions', () => {
  const caller = { sub: 'u1', permissions: ['pipelines:read', 'pipelines:write', 'plugins:read'] };

  it('omitted → full access for an unrestricted caller', async () => {
    expect(await resolveRequestedPermissions(req(caller), 'u1', undefined, undefined)).toEqual({ ok: true });
    expect(mockMembershipForOrg).not.toHaveBeenCalled();
  });

  it('accepts a subset the creator holds now, normalized to catalog order', async () => {
    const out = await resolveRequestedPermissions(req(caller), 'u1', ['plugins:read', 'pipelines:read'], undefined);
    expect(out).toEqual({ ok: true, permissions: ['pipelines:read', 'plugins:read'] });
    expect(mockMembershipForOrg).toHaveBeenCalledWith('u1', 'org-1');
  });

  it('refuses a permission the creator does not hold (403, naming it)', async () => {
    const out = await resolveRequestedPermissions(req(caller), 'u1', ['pipelines:read', 'billing:manage'], undefined);
    expect(out).toMatchObject({ ok: false, status: 403, code: 'PERMISSION_SUBSET_EXCEEDS', missing: ['billing:manage'] });
  });

  it('re-resolves from the Roles: a claim the Roles no longer back is refused', async () => {
    rolePermissions = ['plugins:read']; // pipelines:* removed since the token was minted
    const out = await resolveRequestedPermissions(req(caller), 'u1', ['pipelines:read'], undefined);
    expect(out).toMatchObject({ ok: false, status: 403, missing: ['pipelines:read'] });
  });

  it('is bounded by the calling token too — a restricted token cannot mint wider than itself', async () => {
    const restricted = { sub: 'u1', permissionsRestricted: true, permissions: ['pipelines:read'] };
    const out = await resolveRequestedPermissions(req(restricted), 'u1', ['pipelines:write'], undefined);
    expect(out).toMatchObject({ ok: false, status: 403, missing: ['pipelines:write'] });
  });

  it('a restricted caller asking for "full access" inherits its own current set', async () => {
    const restricted = { sub: 'u1', permissionsRestricted: true, permissions: ['plugins:read', 'pipelines:read'] };
    expect(await resolveRequestedPermissions(req(restricted), 'u1', undefined, undefined))
      .toEqual({ ok: true, permissions: ['pipelines:read', 'plugins:read'] });
  });

  it('a superadmin may pick anything', async () => {
    storedUser = { ...storedUser, isSuperAdmin: true };
    rolePermissions = [];
    const all = { sub: 'u1', permissions: ['registry:read', 'billing:manage'] };
    expect(await resolveRequestedPermissions(req(all), 'u1', ['registry:read'], undefined))
      .toEqual({ ok: true, permissions: ['registry:read'] });
  });

  it.each([
    ['not an array', 'pipelines:read', 'INVALID_PERMISSIONS'],
    ['an unknown id', ['pipelines:read', 'nope:nope'], 'INVALID_PERMISSIONS'],
    ['an empty selection', [], 'INVALID_PERMISSIONS'],
  ])('refuses %s (400)', async (_label, raw, code) => {
    expect(await resolveRequestedPermissions(req(caller), 'u1', raw, undefined)).toMatchObject({ ok: false, status: 400, code });
  });

  it('refuses a subset together with a capability scope', async () => {
    expect(await resolveRequestedPermissions(req(caller), 'u1', ['pipelines:read'], 'reporting:ingest'))
      .toMatchObject({ ok: false, status: 400, code: 'PERMISSIONS_WITH_SCOPE' });
  });
});

describe('callerRestriction', () => {
  it('carries a scope and a restricted caller\'s permissions — and nothing for a plain session', () => {
    expect(callerRestriction(req({ sub: 'u1', permissions: ['pipelines:read'] }))).toEqual({});
    expect(callerRestriction(req({ sub: 'u1', scope: 'registry:push', permissions: [] }))).toEqual({ scope: 'registry:push' });
    expect(callerRestriction(req({ sub: 'u1', permissionsRestricted: true, permissions: ['plugins:read'] })))
      .toEqual({ permissions: ['plugins:read'] });
  });
});
