// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// In-memory Organization model (parent chain) for the hierarchy walk used by
// canAdministerOrg / canAccessOrg via isAncestorOrg.
jest.mock('../src/models', () => {
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

import type { Request } from 'express';
import { canAdministerOrg, canAccessOrg } from '../src/helpers/controller-helper';

const { Organization } = jest.requireMock('../src/models');

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
