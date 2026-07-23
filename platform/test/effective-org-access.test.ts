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

import type { Request } from 'express';

const { Organization } = (await import('../src/models/index.js')) as unknown as {
  Organization: { __set(list: Array<{ _id: string; parentOrgId: string | null }>): void };
};

type U = { role?: string; organizationId?: string; organizationName?: string; isSuperAdmin?: boolean };
const reqWith = (user: U): Request => ({ user } as unknown as Request);

// root ──┬── teamA
//        └── teamB
beforeEach(() => {
  Organization.__set([
    { _id: 'root', parentOrgId: null },
    { _id: 'teamA', parentOrgId: 'root' },
    { _id: 'teamB', parentOrgId: 'root' },
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
