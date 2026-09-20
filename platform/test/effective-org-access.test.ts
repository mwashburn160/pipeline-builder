// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// In-memory Organization model (parent chain) for the hierarchy walk used by
// canAdministerOrg / canAccessOrg via isAncestorOrg.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
jest.unstable_mockModule('../src/models/index.js', () => {
  const orgs = new Map<string, { _id: string; parentOrgId: string | null }>();
  const Organization = {
    __set(list: Array<{ _id: string; parentOrgId: string | null }>) {
      orgs.clear();
      for (const o of list) orgs.set(o._id, o);
    },
    findById(id: unknown) {
      return { select: () => ({ lean: async () => orgs.get(String(id)) ?? null }) };
    },
  };
  return { Organization };
});

const { canAdministerOrg, canAccessOrg, canManageOrgScope } = await import('../src/helpers/controller-helper.js');
const { resolveImpersonationAuthority } = await import('../src/helpers/impersonation-authority.js');

import type { Request } from 'express';

const { Organization } = (await import('../src/models/index.js')) as unknown as {
  Organization: { __set(list: Array<{ _id: string; parentOrgId: string | null }>): void };
};

type U = { role?: string; organizationId?: string; organizationName?: string; isSuperAdmin?: boolean };
const reqWith = (user: U): Request => ({ user } as unknown as Request);

// root ──┬── team-a         other-root ─── other-team
//        └── team-b         (a SEPARATE account: no relationship to root)
//
// Ids are LOWERCASE, as every real org id is (a 24-hex ObjectId string, or the
// `system` sentinel): `normalizeOrgId` is the single spelling rule these
// helpers compare and walk with.
beforeEach(() => {
  Organization.__set([
    { _id: 'root', parentOrgId: null },
    { _id: 'team-a', parentOrgId: 'root' },
    { _id: 'team-b', parentOrgId: 'root' },
    { _id: 'other-root', parentOrgId: null },
    { _id: 'other-team', parentOrgId: 'other-root' },
  ]);
});

describe('canAdministerOrg', () => {
  it('lets a super admin administer any org', async () => {
    expect(await canAdministerOrg(reqWith({ isSuperAdmin: true, role: 'member', organizationId: 'x' }), 'team-a')).toBe(true);
  });

  it('lets an org admin administer their own org', async () => {
    expect(await canAdministerOrg(reqWith({ role: 'admin', organizationId: 'team-a' }), 'team-a')).toBe(true);
  });

  it('lets a parent-org admin/owner administer a child team', async () => {
    expect(await canAdministerOrg(reqWith({ role: 'owner', organizationId: 'root' }), 'team-a')).toBe(true);
  });

  it('denies a member of their own org', async () => {
    expect(await canAdministerOrg(reqWith({ role: 'member', organizationId: 'team-a' }), 'team-a')).toBe(false);
  });

  it('denies an admin acting on a sibling org', async () => {
    expect(await canAdministerOrg(reqWith({ role: 'admin', organizationId: 'team-a' }), 'team-b')).toBe(false);
  });

  it('denies a child admin acting on the parent (no upward authority)', async () => {
    expect(await canAdministerOrg(reqWith({ role: 'admin', organizationId: 'team-a' }), 'root')).toBe(false);
  });
});

// canManageOrgScope is the tenancy gate for permission-gated writes (member/role
// routes): the route's requirePermission is the sole CAPABILITY gate, so this must
// NOT re-assert coarse org-admin — a delegated non-admin holding the permission is
// honored — while still confining the write to the caller's own org/subtree.
describe('canManageOrgScope', () => {
  it('lets a super admin manage any org', async () => {
    expect(await canManageOrgScope(reqWith({ isSuperAdmin: true, role: 'member', organizationId: 'x' }), 'team-a')).toBe(true);
  });

  it('honors a NON-admin (delegated permission holder) acting on their OWN org', async () => {
    // The key delegation fix: canAdministerOrg would 403 this member, but the fine
    // permission was already authorized at the route, so the scope gate allows it.
    expect(await canManageOrgScope(reqWith({ role: 'member', organizationId: 'team-a' }), 'team-a')).toBe(true);
    // Contrast with the coarse gate, which (correctly, for its own callers) denies.
    expect(await canAdministerOrg(reqWith({ role: 'member', organizationId: 'team-a' }), 'team-a')).toBe(false);
  });

  it('honors a delegated permission holder in a PARENT org acting on a child team', async () => {
    expect(await canManageOrgScope(reqWith({ role: 'member', organizationId: 'root' }), 'team-a')).toBe(true);
  });

  it('denies acting on a SIBLING org (out of tenancy scope)', async () => {
    expect(await canManageOrgScope(reqWith({ role: 'admin', organizationId: 'team-a' }), 'team-b')).toBe(false);
  });

  it('denies acting UP the tree on the parent (no upward authority)', async () => {
    expect(await canManageOrgScope(reqWith({ role: 'admin', organizationId: 'team-a' }), 'root')).toBe(false);
  });

  it('denies a caller with no active org', async () => {
    expect(await canManageOrgScope(reqWith({ role: 'admin' }), 'team-a')).toBe(false);
  });
});

describe('canAccessOrg', () => {
  it('lets a member read their own org', async () => {
    expect(await canAccessOrg(reqWith({ role: 'member', organizationId: 'team-a' }), 'team-a')).toBe(true);
  });

  it('denies a member reading a sibling org', async () => {
    expect(await canAccessOrg(reqWith({ role: 'member', organizationId: 'team-a' }), 'team-b')).toBe(false);
  });

  it('lets a parent-org admin read a child team', async () => {
    expect(await canAccessOrg(reqWith({ role: 'admin', organizationId: 'root' }), 'team-a')).toBe(true);
  });

  it('denies a parent-org member reading a child team (no inherited read for members)', async () => {
    expect(await canAccessOrg(reqWith({ role: 'member', organizationId: 'root' }), 'team-a')).toBe(false);
  });

  // Isolation: access only flows DOWN the tree (parent admin → child), never up.
  it('denies a child admin reading its parent (no upward access)', async () => {
    expect(await canAccessOrg(reqWith({ role: 'admin', organizationId: 'team-a' }), 'root')).toBe(false);
  });

  it('denies a child member reading its parent', async () => {
    expect(await canAccessOrg(reqWith({ role: 'member', organizationId: 'team-a' }), 'root')).toBe(false);
  });

  it('denies a member reading any unrelated/sibling org even with admin elsewhere implied', async () => {
    // A team-a admin has no read on team-b (sibling) — ancestry, not adjacency.
    expect(await canAccessOrg(reqWith({ role: 'admin', organizationId: 'team-a' }), 'team-b')).toBe(false);
  });
});


/**
 * THE CROSS-ORGANIZATION RULE, pinned across every check that lets one
 * organization reach into another without membership:
 *
 *   Except for a platform sysadmin (the system organization), an organization
 *   cannot reach into another organization unless that organization is its
 *   CHILD team.
 *
 * Sibling and parent cases are covered above; these add the case the rule most
 * directly protects — a completely SEPARATE account — and run impersonation
 * against the real hierarchy walk rather than a mock. (Switching organizations is
 * deliberately NOT governed by this rule: it follows the user's own active
 * memberships.)
 */
describe('cross-organization rule: no reach into a separate account', () => {
  const adminOf = (org: string) => reqWith({ role: 'admin', organizationId: org });

  it('canAdministerOrg: an admin of one account cannot administer another', async () => {
    expect(await canAdministerOrg(adminOf('root'), 'other-root')).toBe(false);
    expect(await canAdministerOrg(adminOf('root'), 'other-team')).toBe(false);
    expect(await canAdministerOrg(adminOf('other-root'), 'team-a')).toBe(false);
  });

  it('canAccessOrg: an admin of one account cannot read another', async () => {
    expect(await canAccessOrg(adminOf('root'), 'other-root')).toBe(false);
    expect(await canAccessOrg(adminOf('other-root'), 'team-a')).toBe(false);
  });

  it('canManageOrgScope: a permission holder in one account cannot write to another', async () => {
    expect(await canManageOrgScope(adminOf('root'), 'other-team')).toBe(false);
    expect(await canManageOrgScope(reqWith({ role: 'member', organizationId: 'other-root' }), 'root')).toBe(false);
  });

  it('a sysadmin (system organization) may reach any organization', async () => {
    const sys = reqWith({ isSuperAdmin: true, role: 'member', organizationId: 'system' });
    expect(await canAdministerOrg(sys, 'other-team')).toBe(true);
    expect(await canAccessOrg(sys, 'team-a')).toBe(true);
  });
});

describe('cross-organization rule: impersonation (real hierarchy)', () => {
  const adminOf = (org: string) => reqWith({ role: 'admin', organizationId: org });

  it('allows a parent admin into its CHILD team', async () => {
    await expect(resolveImpersonationAuthority(adminOf('root'), 'team-a')).resolves.toEqual({ kind: 'ancestor', viaOrgId: 'root' });
  });

  it('refuses a separate account', async () => {
    await expect(resolveImpersonationAuthority(adminOf('root'), 'other-root')).resolves.toEqual({ kind: 'none' });
    await expect(resolveImpersonationAuthority(adminOf('root'), 'other-team')).resolves.toEqual({ kind: 'none' });
  });

  it('refuses a sibling team, the parent, and the admin\'s own organization', async () => {
    await expect(resolveImpersonationAuthority(adminOf('team-a'), 'team-b')).resolves.toEqual({ kind: 'none' });
    await expect(resolveImpersonationAuthority(adminOf('team-a'), 'root')).resolves.toEqual({ kind: 'none' });
    await expect(resolveImpersonationAuthority(adminOf('root'), 'root')).resolves.toEqual({ kind: 'none' });
  });

  it('allows a sysadmin (system organization) into any organization', async () => {
    const sys = reqWith({ isSuperAdmin: true, role: 'member', organizationId: 'system' });
    await expect(resolveImpersonationAuthority(sys, 'other-team')).resolves.toEqual({ kind: 'sysadmin' });
  });
});

/**
 * Org-id CASE. Platform compared raw strings while quota's `authorizeOrg` and
 * every `getIdentity`-derived `orgId` normalize to lowercase — so a mixed-case
 * 24-hex id (hex is case-insensitive, so it resolves to the SAME document
 * everywhere else) passed one hop and 403'd at the next. All three helpers now
 * compare and walk through api-core's `normalizeOrgId`.
 */
describe('org-id case is normalized on both sides', () => {
  const HEX_ROOT = 'abcdef012345678901234567';
  const HEX_TEAM = 'abcdef012345678901234568';

  beforeEach(() => {
    Organization.__set([
      { _id: HEX_ROOT, parentOrgId: null },
      { _id: HEX_TEAM, parentOrgId: HEX_ROOT },
    ]);
  });

  it('matches the caller\'s own org whatever the casing of either side', async () => {
    const upperClaim = reqWith({ role: 'admin', organizationId: HEX_TEAM.toUpperCase() });
    expect(await canAdministerOrg(upperClaim, HEX_TEAM)).toBe(true);
    expect(await canAccessOrg(upperClaim, HEX_TEAM)).toBe(true);
    expect(await canManageOrgScope(upperClaim, HEX_TEAM)).toBe(true);

    const upperTarget = reqWith({ role: 'admin', organizationId: HEX_TEAM });
    expect(await canAdministerOrg(upperTarget, HEX_TEAM.toUpperCase())).toBe(true);
    expect(await canAccessOrg(upperTarget, HEX_TEAM.toUpperCase())).toBe(true);
    expect(await canManageOrgScope(upperTarget, HEX_TEAM.toUpperCase())).toBe(true);
  });

  it('walks the hierarchy with the canonical spelling too', async () => {
    // Stored `parentOrgId` strings are lowercase, so an un-normalized walk
    // matched nothing and a parent admin lost authority over their own team.
    const parentAdmin = reqWith({ role: 'owner', organizationId: HEX_ROOT.toUpperCase() });
    expect(await canAdministerOrg(parentAdmin, HEX_TEAM.toUpperCase())).toBe(true);
    expect(await canAccessOrg(parentAdmin, HEX_TEAM)).toBe(true);
  });

  it('still refuses an unrelated org, whatever the casing', async () => {
    const admin = reqWith({ role: 'admin', organizationId: HEX_TEAM });
    expect(await canAdministerOrg(admin, HEX_ROOT.toUpperCase())).toBe(false);
    expect(await canManageOrgScope(admin, 'FFFFFF012345678901234567')).toBe(false);
  });
});
