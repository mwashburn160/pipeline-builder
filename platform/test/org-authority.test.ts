// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * helpers/org-authority.ts — the single rule for who may be "in" an org:
 * a membership row, or admin authority inherited from a live ancestor. Plus the
 * refresh path (`isValidRefreshToken` → `populateRequestUser`), which must apply
 * the same rule so a parent admin working in a team stays there across a refresh.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { queryChain } from './helpers/query-chain.js';

interface Org { _id: string; parentOrgId?: string | null; deletedAt?: Date | null; name?: string }
interface Membership { userId: string; organizationId: string; role: string; isActive: boolean }

const orgs = new Map<string, Org>();
let memberships: Membership[] = [];

function matches(m: Membership, q: Record<string, any>): boolean {
  if (q.userId !== undefined && m.userId !== q.userId) return false;
  if (q.organizationId !== undefined && m.organizationId !== String(q.organizationId)) return false;
  if (q.isActive !== undefined && m.isActive !== q.isActive) return false;
  if (q.role?.$in && !q.role.$in.includes(m.role)) return false;
  return true;
}

const mockVerifyRefreshToken = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isServiceTokenDenied: () => false,
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  Organization: { findById: (id: string) => queryChain(orgs.get(String(id)) ?? null) },
  UserOrganization: { findOne: (q: Record<string, any>) => queryChain(memberships.find((m) => matches(m, q)) ?? null) },
  PersonalAccessToken: { findOne: jest.fn(), updateOne: jest.fn() },
  ImpersonationRequest: { findOne: jest.fn() },
  Role: { find: jest.fn() },
  RoleAssignment: { find: jest.fn() },
}));
jest.unstable_mockModule('../src/utils/token.js', () => ({
  verifyAccessToken: jest.fn(),
  verifyRefreshToken: (...a: unknown[]) => mockVerifyRefreshToken(...a),
}));

const { resolveOrgAuthority, findAncestorAdminMembership } = await import('../src/helpers/org-authority.js');
const { isValidRefreshToken } = await import('../src/middleware/auth.js');

beforeEach(() => {
  jest.clearAllMocks();
  orgs.clear();
  orgs.set('root', { _id: 'root', name: 'Root', parentOrgId: null });
  orgs.set('team', { _id: 'team', name: 'Blue', parentOrgId: 'root' });
  memberships = [];
});

describe('resolveOrgAuthority', () => {
  it('a direct membership resolves as-is', async () => {
    memberships = [{ userId: 'u', organizationId: 'team', role: 'member', isActive: true }];
    await expect(resolveOrgAuthority('u', 'team')).resolves.toEqual({ role: 'member', via: 'membership', permissionOrgIds: ['team'] });
  });

  it('an ancestor admin/owner inherits ADMIN (never owner) with the ancestor\'s permissions', async () => {
    memberships = [{ userId: 'u', organizationId: 'root', role: 'owner', isActive: true }];
    await expect(resolveOrgAuthority('u', 'team')).resolves.toEqual({
      role: 'admin', via: 'ancestor', inheritedFromOrgId: 'root', permissionOrgIds: ['root'],
    });
  });

  it('inherited admin outranks a plain-member row (permissions from both orgs); a direct admin row wins outright', async () => {
    memberships = [
      { userId: 'u', organizationId: 'root', role: 'admin', isActive: true },
      { userId: 'u', organizationId: 'team', role: 'member', isActive: true },
    ];
    await expect(resolveOrgAuthority('u', 'team')).resolves.toMatchObject({ role: 'admin', via: 'ancestor', permissionOrgIds: ['root', 'team'] });

    memberships[1].role = 'admin';
    await expect(resolveOrgAuthority('u', 'team')).resolves.toEqual({ role: 'admin', via: 'membership', permissionOrgIds: ['team'] });
  });

  it('refuses a plain member of the parent, an inactive admin, and an admin of a soft-deleted parent', async () => {
    memberships = [{ userId: 'u', organizationId: 'root', role: 'member', isActive: true }];
    await expect(resolveOrgAuthority('u', 'team')).resolves.toBeUndefined();

    memberships = [{ userId: 'u', organizationId: 'root', role: 'admin', isActive: false }];
    await expect(resolveOrgAuthority('u', 'team')).resolves.toBeUndefined();

    memberships = [{ userId: 'u', organizationId: 'root', role: 'admin', isActive: true }];
    orgs.set('root', { ...orgs.get('root')!, deletedAt: new Date() });
    await expect(resolveOrgAuthority('u', 'team')).resolves.toBeUndefined();
  });

  it('gives a team admin no authority UP over the parent', async () => {
    memberships = [{ userId: 'u', organizationId: 'team', role: 'admin', isActive: true }];
    await expect(resolveOrgAuthority('u', 'root')).resolves.toBeUndefined();
  });
});

describe('findAncestorAdminMembership', () => {
  it('terminates on a cyclic chain instead of looping', async () => {
    orgs.set('x', { _id: 'x', parentOrgId: 'y' });
    orgs.set('y', { _id: 'y', parentOrgId: 'x' });
    await expect(findAncestorAdminMembership('u', 'x')).resolves.toBeUndefined();
  });
});

describe('refresh path keeps an inherited-authority session in its team', () => {
  function refreshAs(lastActiveOrgId: string) {
    mockVerifyRefreshToken.mockReturnValue({ sub: 'u', tokenVersion: 1, sid: 's1' });
    mockUserFindById.mockReturnValue({
      select: async () => ({
        _id: 'u',
        tokenVersion: 1,
        username: 'u',
        email: 'u@x.com',
        isEmailVerified: true,
        lastActiveOrgId,
        refreshSessions: [{ id: 's1', kind: 'interactive', amr: ['pwd'], aal: 1, authTime: new Date(0) }],
      }),
    });
    const req: any = { headers: { 'x-pb-client': 'cli' }, body: { refreshToken: 'rt' } };
    const res: any = { locals: {}, status: jest.fn(() => res), json: jest.fn(() => res) };
    return { req, res };
  }

  it('resolves the team (as admin) for a parent admin with no membership row', async () => {
    memberships = [{ userId: 'u', organizationId: 'root', role: 'owner', isActive: true }];
    const { req, res } = refreshAs('team');
    const next = jest.fn();

    await isValidRefreshToken(req, res, next as any);

    expect(next).toHaveBeenCalled();
    expect(req.user).toMatchObject({ organizationId: 'team', organizationName: 'Blue', role: 'admin', isAdmin: true });
  });
});
