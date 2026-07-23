// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Startup backfill for the single-source "Roles" RBAC model:
 *   - Pass A: RE-SYNC every built-in (system) Role's permission bundle to the
 *     CURRENT source of truth for its `grantsRole` (admin/superadmin → admin
 *     bundle, member → member bundle). Overwrites a stale list — so a newly-added
 *     catalog permission reaches existing orgs — and is a no-op when already in
 *     sync. Never touches user-authored custom Roles (system:false).
 *   - Pass B: every active membership is ensured to hold the built-in Role
 *     matching its role, keyed off grantsRole (member → Member, admin/owner → Admin).
 *   - Idempotent + cheap on a no-op (re-run inserts nothing, rewrites nothing).
 */

import { jest, describe, it, expect, beforeEach, test } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGroupFind = jest.fn();
const mockGroupUpdateOne = jest.fn();
const mockGmUpdateOne = jest.fn();
const mockUoFind = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('mongoose', () => ({
  default: { Types: { ObjectId: class {} } },
  Types: { ObjectId: class {} },
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Role: {
    find: (...a: unknown[]) => mockGroupFind(...a),
    updateOne: (...a: unknown[]) => mockGroupUpdateOne(...a),
  },
  RoleAssignment: { updateOne: (...a: unknown[]) => mockGmUpdateOne(...a) },
  UserOrganization: { find: (...a: unknown[]) => mockUoFind(...a) },
  // rbac-backfill pulls in roles-service (for permissionsForGrantsRole), which
  // imports User too — expose it so ESM linking against the mock succeeds.
  User: {},
}));

const { backfillRbacRoles } = await import('../src/services/rbac-backfill.js');
// The permission bundles the re-sync targets (mirrors api-core ROLE_PERMISSIONS).
const { ROLE_PERMISSIONS } = (await import('@pipeline-builder/api-core')) as unknown as {
  ROLE_PERMISSIONS: { member: string[]; admin: string[] };
};
const MEMBER_BUNDLE = [...ROLE_PERMISSIONS.member];
const ADMIN_BUNDLE = [...ROLE_PERMISSIONS.admin];

// `.select(...).lean()` chain used by both Role.find + UserOrganization.find.
const selectLean = (rows: unknown[]) => ({ select: () => ({ lean: () => Promise.resolve(rows) }) });

// Pass A finds ALL system Roles (no `grantsRole` filter); Pass B finds only the
// member/admin built-ins (filter carries `grantsRole`). Discriminate on that.
const findImpl = (passA: unknown[], passB: unknown[]) =>
  (filter: { grantsRole?: unknown }) => selectLean(filter && filter.grantsRole ? passB : passA);

beforeEach(() => {
  jest.clearAllMocks();
  mockGroupUpdateOne.mockResolvedValue({});
});

describe('backfillRbacRoles', () => {
  it('re-syncs a stale built-in Role, skips an in-sync one, and adds a baseline-less member', async () => {
    // Pass A: the Member Role carries a STALE (partial) list → must be rewritten to
    // the current member bundle; the Admin Role is already in sync → skipped.
    mockGroupFind.mockImplementation(findImpl(
      [
        { _id: 'gD', grantsRole: 'member', permissions: ['pipelines:read'] }, // stale
        { _id: 'gA', grantsRole: 'admin', permissions: ADMIN_BUNDLE }, // in sync
      ],
      [
        { _id: 'gD', organizationId: 'org-1', grantsRole: 'member' },
        { _id: 'gA', organizationId: 'org-1', grantsRole: 'admin' },
      ],
    ));
    mockUoFind.mockReturnValue(selectLean([
      { userId: 'u1', organizationId: 'org-1', role: 'member' },
      { userId: 'u2', organizationId: 'org-1', role: 'admin' },
    ]));
    // u1 gets inserted into the Member Role (new); u2 already in Admin (no-op).
    mockGmUpdateOne.mockImplementation((f: { userId: string }) =>
      Promise.resolve({ upsertedCount: f.userId === 'u1' ? 1 : 0 }));

    const summary = await backfillRbacRoles();

    expect(summary).toEqual({ orgsScanned: 1, rolesBackfilled: 1, assignmentsAdded: 1 });

    // Pass A queries system Roles only — custom (system:false) Roles are never fetched.
    expect(mockGroupFind).toHaveBeenCalledWith({ system: true });

    // Only the stale Member Role was rewritten, to the current member bundle
    // (has member grants, not the admin-only ones).
    expect(mockGroupUpdateOne).toHaveBeenCalledTimes(1);
    const call = mockGroupUpdateOne.mock.calls[0] as [{ _id: string }, { $set: { permissions: string[] } }];
    expect(call[0]).toEqual({ _id: 'gD' });
    const setPerms = call[1].$set.permissions;
    expect(setPerms).toEqual(expect.arrayContaining(MEMBER_BUNDLE));
    expect(setPerms).toHaveLength(MEMBER_BUNDLE.length);
    expect(setPerms).toContain('pipelines:write');
    expect(setPerms).not.toContain('roles:manage');

    // Pass B: member → Member Role, admin → Admin Role (idempotent upserts).
    expect(mockGmUpdateOne).toHaveBeenCalledWith(
      { userId: 'u1', roleId: 'gD' },
      { $setOnInsert: { userId: 'u1', roleId: 'gD', organizationId: 'org-1' } },
      { upsert: true },
    );
    expect(mockGmUpdateOne).toHaveBeenCalledWith(
      { userId: 'u2', roleId: 'gA' },
      { $setOnInsert: { userId: 'u2', roleId: 'gA', organizationId: 'org-1' } },
      { upsert: true },
    );
  });

  it('is a clean no-op when every built-in Role is already in sync', async () => {
    // Both built-ins already carry the exact current bundle → nothing rewritten.
    mockGroupFind.mockImplementation(findImpl(
      [
        { _id: 'gD', grantsRole: 'member', permissions: MEMBER_BUNDLE },
        { _id: 'gA', grantsRole: 'admin', permissions: ADMIN_BUNDLE },
      ],
      [
        { _id: 'gD', organizationId: 'org-1', grantsRole: 'member' },
        { _id: 'gA', organizationId: 'org-1', grantsRole: 'admin' },
      ],
    ));
    mockUoFind.mockReturnValue(selectLean([
      { userId: 'u1', organizationId: 'org-1', role: 'member' },
      { userId: 'u2', organizationId: 'org-1', role: 'admin' },
    ]));
    mockGmUpdateOne.mockResolvedValue({ upsertedCount: 0 }); // all already present

    const summary = await backfillRbacRoles();

    expect(summary).toEqual({ orgsScanned: 1, rolesBackfilled: 0, assignmentsAdded: 0 });
    expect(mockGroupUpdateOne).not.toHaveBeenCalled(); // no Role bundle rewrites
  });

  it('re-syncs a built-in Role whose stored list is missing entirely', async () => {
    // A Role doc with no `permissions` field at all still gets the current bundle
    // (the old only-when-empty fill covered this; the re-sync must too).
    mockGroupFind.mockImplementation(findImpl(
      [{ _id: 'gD', grantsRole: 'member' }], // no permissions field
      [],
    ));
    mockUoFind.mockReturnValue(selectLean([]));

    const summary = await backfillRbacRoles();

    expect(summary.rolesBackfilled).toBe(1);
    const call = mockGroupUpdateOne.mock.calls[0] as [{ _id: string }, { $set: { permissions: string[] } }];
    expect(call[1].$set.permissions).toEqual(expect.arrayContaining(MEMBER_BUNDLE));
  });

  it('skips memberships in an org with no built-in Roles (unseeded org)', async () => {
    mockGroupFind.mockImplementation(findImpl([], [])); // no built-ins anywhere
    mockUoFind.mockReturnValue(selectLean([
      { userId: 'u1', organizationId: 'orphan-org', role: 'member' },
    ]));

    const summary = await backfillRbacRoles();

    expect(summary).toEqual({ orgsScanned: 1, rolesBackfilled: 0, assignmentsAdded: 0 });
    expect(mockGmUpdateOne).not.toHaveBeenCalled();
  });
});
