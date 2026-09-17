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

// root ──┬── teamA          otherRoot ─── otherTeam
//        └── teamB          (a SEPARATE account: no relationship to root)
beforeEach(() => {
  Organization.__set([
    { _id: 'root', parentOrgId: null },
    { _id: 'teamA', parentOrgId: 'root' },
    { _id: 'teamB', parentOrgId: 'root' },
    { _id: 'otherRoot', parentOrgId: null },
    { _id: 'otherTeam', parentOrgId: 'otherRoot' },
  ]);
});

describe('canAdministerOrg', () => {
  it('lets a super admin administer any org', async () => {
    expect(await canAdministerOrg(reqWith({ isSuperAdmin: true, role: 'member', organizationId: 'x' }), 'teamA')).toBe(true);
  });

  it('lets an org admin administer their own org', async () => {
    expect(await canAdministerOrg(reqWith({ role: 'admin', organizationId: 'teamA' }), 'teamA')).toBe(true);
  });

  it('lets a parent-org admin/owner administer a child team', async () => {
    expect(await canAdministerOrg(reqWith({ role: 'owner', organizationId: 'root' }), 'teamA')).toBe(true);
  });

  it('denies a member of their own org', async () => {
    expect(await canAdministerOrg(reqWith({ role: 'member', organizationId: 'teamA' }), 'teamA')).toBe(false);
  });

  it('denies an admin acting on a sibling org', async () => {
    expect(await canAdministerOrg(reqWith({ role: 'admin', organizationId: 'teamA' }), 'teamB')).toBe(false);
  });

  it('denies a child admin acting on the parent (no upward authority)', async () => {
    expect(await canAdministerOrg(reqWith({ role: 'admin', organizationId: 'teamA' }), 'root')).toBe(false);
  });
});

// canManageOrgScope is the tenancy gate for permission-gated writes (member/role
// routes): the route's requirePermission is the sole CAPABILITY gate, so this must
// NOT re-assert coarse org-admin — a delegated non-admin holding the permission is
// honored — while still confining the write to the caller's own org/subtree.
describe('canManageOrgScope', () => {
  it('lets a super admin manage any org', async () => {
    expect(await canManageOrgScope(reqWith({ isSuperAdmin: true, role: 'member', organizationId: 'x' }), 'teamA')).toBe(true);
  });

  it('honors a NON-admin (delegated permission holder) acting on their OWN org', async () => {
    // The key delegation fix: canAdministerOrg would 403 this member, but the fine
    // permission was already authorized at the route, so the scope gate allows it.
    expect(await canManageOrgScope(reqWith({ role: 'member', organizationId: 'teamA' }), 'teamA')).toBe(true);
    // Contrast with the coarse gate, which (correctly, for its own callers) denies.
    expect(await canAdministerOrg(reqWith({ role: 'member', organizationId: 'teamA' }), 'teamA')).toBe(false);
  });

  it('honors a delegated permission holder in a PARENT org acting on a child team', async () => {
    expect(await canManageOrgScope(reqWith({ role: 'member', organizationId: 'root' }), 'teamA')).toBe(true);
  });

  it('denies acting on a SIBLING org (out of tenancy scope)', async () => {
    expect(await canManageOrgScope(reqWith({ role: 'admin', organizationId: 'teamA' }), 'teamB')).toBe(false);
  });

  it('denies acting UP the tree on the parent (no upward authority)', async () => {
    expect(await canManageOrgScope(reqWith({ role: 'admin', organizationId: 'teamA' }), 'root')).toBe(false);
  });

  it('denies a caller with no active org', async () => {
    expect(await canManageOrgScope(reqWith({ role: 'admin' }), 'teamA')).toBe(false);
  });
});

describe('canAccessOrg', () => {
  it('lets a member read their own org', async () => {
    expect(await canAccessOrg(reqWith({ role: 'member', organizationId: 'teamA' }), 'teamA')).toBe(true);
  });

  it('denies a member reading a sibling org', async () => {
    expect(await canAccessOrg(reqWith({ role: 'member', organizationId: 'teamA' }), 'teamB')).toBe(false);
  });

  it('lets a parent-org admin read a child team', async () => {
    expect(await canAccessOrg(reqWith({ role: 'admin', organizationId: 'root' }), 'teamA')).toBe(true);
  });

  it('denies a parent-org member reading a child team (no inherited read for members)', async () => {
    expect(await canAccessOrg(reqWith({ role: 'member', organizationId: 'root' }), 'teamA')).toBe(false);
  });

  // Isolation: access only flows DOWN the tree (parent admin → child), never up.
  it('denies a child admin reading its parent (no upward access)', async () => {
    expect(await canAccessOrg(reqWith({ role: 'admin', organizationId: 'teamA' }), 'root')).toBe(false);
  });

  it('denies a child member reading its parent', async () => {
    expect(await canAccessOrg(reqWith({ role: 'member', organizationId: 'teamA' }), 'root')).toBe(false);
  });

  it('denies a member reading any unrelated/sibling org even with admin elsewhere implied', async () => {
    // A teamA admin has no read on teamB (sibling) — ancestry, not adjacency.
    expect(await canAccessOrg(reqWith({ role: 'admin', organizationId: 'teamA' }), 'teamB')).toBe(false);
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
    expect(await canAdministerOrg(adminOf('root'), 'otherRoot')).toBe(false);
    expect(await canAdministerOrg(adminOf('root'), 'otherTeam')).toBe(false);
    expect(await canAdministerOrg(adminOf('otherRoot'), 'teamA')).toBe(false);
  });

  it('canAccessOrg: an admin of one account cannot read another', async () => {
    expect(await canAccessOrg(adminOf('root'), 'otherRoot')).toBe(false);
    expect(await canAccessOrg(adminOf('otherRoot'), 'teamA')).toBe(false);
  });

  it('canManageOrgScope: a permission holder in one account cannot write to another', async () => {
    expect(await canManageOrgScope(adminOf('root'), 'otherTeam')).toBe(false);
    expect(await canManageOrgScope(reqWith({ role: 'member', organizationId: 'otherRoot' }), 'root')).toBe(false);
  });

  it('a sysadmin (system organization) may reach any organization', async () => {
    const sys = reqWith({ isSuperAdmin: true, role: 'member', organizationId: 'system' });
    expect(await canAdministerOrg(sys, 'otherTeam')).toBe(true);
    expect(await canAccessOrg(sys, 'teamA')).toBe(true);
  });
});

describe('cross-organization rule: impersonation (real hierarchy)', () => {
  const adminOf = (org: string) => reqWith({ role: 'admin', organizationId: org });

  it('allows a parent admin into its CHILD team', async () => {
    await expect(resolveImpersonationAuthority(adminOf('root'), 'teamA')).resolves.toEqual({ kind: 'ancestor', viaOrgId: 'root' });
  });

  it('refuses a separate account', async () => {
    await expect(resolveImpersonationAuthority(adminOf('root'), 'otherRoot')).resolves.toEqual({ kind: 'none' });
    await expect(resolveImpersonationAuthority(adminOf('root'), 'otherTeam')).resolves.toEqual({ kind: 'none' });
  });

  it('refuses a sibling team, the parent, and the admin\'s own organization', async () => {
    await expect(resolveImpersonationAuthority(adminOf('teamA'), 'teamB')).resolves.toEqual({ kind: 'none' });
    await expect(resolveImpersonationAuthority(adminOf('teamA'), 'root')).resolves.toEqual({ kind: 'none' });
    await expect(resolveImpersonationAuthority(adminOf('root'), 'root')).resolves.toEqual({ kind: 'none' });
  });

  it('allows a sysadmin (system organization) into any organization', async () => {
    const sys = reqWith({ isSuperAdmin: true, role: 'member', organizationId: 'system' });
    await expect(resolveImpersonationAuthority(sys, 'otherTeam')).resolves.toEqual({ kind: 'sysadmin' });
  });
});
