// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/users` admin routes: the `members:manage` PERMISSION governs, not the coarse
 * admin/owner role. The route's `requirePermission` is the capability gate; the
 * controller adds only the tenancy scope (the caller's active org, or a
 * descendant team), exactly like `canManageOrgScope`. So a custom Role holding
 * `members:manage` works — while account-level edits stay platform-admin only,
 * and granting/revoking Admin stays bounded by the caller's own permissions.
 *
 * Runs the REAL controller-helper scope logic; only the service and the
 * hierarchy walk are stubbed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetUserIdsInOrg = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockList = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockHasMembership = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockUpdateUserById = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockDeleteUserById = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockIsAncestorOrg = jest.fn<(...a: unknown[]) => Promise<boolean>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (r: any, status: number, message: string, code?: string) => r.status(status).json({ success: false, message, code }),
  sendSuccess: (r: any, status: number, data: unknown) => r.status(status).json({ success: true, data }),
  parsePaginationParams: () => ({ offset: 0, limit: 20 }),
  isSystemOrgId: () => false,
  // Linking stubs for exports these handlers don't exercise.
  validateBulkArray: jest.fn(),
  isValidFeatureFlag: () => true,
  resolveUserFeatures: jest.fn(() => []),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ isAncestorOrg: (...a: unknown[]) => mockIsAncestorOrg(...a) }));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { passwordMinLength: 8 } } }));
jest.unstable_mockModule('../src/controllers/user-profile.js', () => ({
  formatUserResponse: (u: unknown) => u, toUserResponseInput: (u: unknown) => u, toOverridesRecord: (v: unknown) => v,
}));
jest.unstable_mockModule('../src/models/index.js', () => ({ Organization: { findById: jest.fn() } }));
jest.unstable_mockModule('../src/services/index.js', () => ({
  userAdminService: {
    getUserIdsInOrg: (...a: unknown[]) => mockGetUserIdsInOrg(...a),
    list: (...a: unknown[]) => mockList(...a),
    hasMembershipInOrg: (...a: unknown[]) => mockHasMembership(...a),
    updateUserById: (...a: unknown[]) => mockUpdateUserById(...a),
    deleteUserById: (...a: unknown[]) => mockDeleteUserById(...a),
    lookupPrimaryOrgId: async () => 'org-1',
  },
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  adminCreateUserSchema: {}, adminUpdateUserSchema: {}, validateBody: (_s: unknown, body: unknown) => body,
}));

const { listAllUsers, updateUserById, deleteUserById } = await import('../src/controllers/user-admin.js');

/** A member of org-1 whose custom Role grants `members:manage` — not an admin/owner. */
const delegate = (over: Record<string, unknown> = {}) => ({
  sub: 'delegate', role: 'member', isAdmin: false, organizationId: 'org-1', permissions: ['members:manage'], ...over,
});

function res() {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  return r;
}
const call = async (handler: unknown, req: Record<string, unknown>) => {
  const r = res();
  await (handler as (q: unknown, s: unknown) => Promise<void>)({ params: {}, query: {}, body: {}, ...req }, r);
  return r;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserIdsInOrg.mockResolvedValue([]);
  mockList.mockResolvedValue({ users: [], total: 0, membershipsByUser: new Map(), orgNameMap: new Map() });
  mockHasMembership.mockResolvedValue(true);
  mockUpdateUserById.mockResolvedValue({ user: { _id: 'u2' }, changes: ['role'] });
  mockIsAncestorOrg.mockResolvedValue(false);
});

describe('/users with a members:manage delegate (not an admin/owner)', () => {
  it('lists users of the caller\'s own org', async () => {
    const r = await call(listAllUsers, { user: delegate() });
    expect(r.status).toHaveBeenCalledWith(200);
    expect(mockGetUserIdsInOrg).toHaveBeenCalledWith('org-1');
  });

  it('lists a descendant team, but not an unrelated org', async () => {
    mockIsAncestorOrg.mockImplementation(async (active, target) => active === 'org-1' && target === 'team-a');
    expect((await call(listAllUsers, { user: delegate(), query: { organizationId: 'team-a' } })).status).toHaveBeenCalledWith(200);
    expect((await call(listAllUsers, { user: delegate(), query: { organizationId: 'org-other' } })).status).toHaveBeenCalledWith(403);
  });

  it('updates a member of their org, scoped to it and carrying their permission ceiling', async () => {
    const r = await call(updateUserById, { user: delegate(), params: { id: 'u2' }, body: { role: 'member' } });
    expect(r.status).toHaveBeenCalledWith(200);
    expect(mockUpdateUserById).toHaveBeenCalledWith('u2', { role: 'member' }, expect.objectContaining({
      scopeOrgId: 'org-1',
      actor: { isSuperAdmin: false, isOrgAdmin: false, permissions: ['members:manage'] },
    }));
  });

  it('still refuses account-level edits and account deletion (platform admin only)', async () => {
    const edit = await call(updateUserById, { user: delegate(), params: { id: 'u2' }, body: { email: 'x@evil.com' } });
    expect(edit.status).toHaveBeenCalledWith(403);
    const del = await call(deleteUserById, { user: delegate(), params: { id: 'u2' } });
    expect(del.status).toHaveBeenCalledWith(403);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockDeleteUserById).not.toHaveBeenCalled();
  });

  it('refuses a caller with no active org', async () => {
    const r = await call(listAllUsers, { user: delegate({ organizationId: undefined }) });
    expect(r.status).toHaveBeenCalledWith(403);
  });

  it('a platform admin is not org-scoped', async () => {
    const r = await call(updateUserById, { user: { sub: 'op', isSuperAdmin: true, permissions: [] }, params: { id: 'u2' }, body: { role: 'admin' } });
    expect(r.status).toHaveBeenCalledWith(200);
    expect(mockHasMembership).not.toHaveBeenCalled();
    expect(mockUpdateUserById.mock.calls[0][2]).toMatchObject({ scopeOrgId: undefined, actor: { isSuperAdmin: true } });
  });
});
