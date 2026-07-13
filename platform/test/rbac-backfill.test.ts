// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Startup backfill for the single-source "Roles" RBAC model:
 *   - Pass A: empty built-in Roles get their permission bundle from the coarse
 *     `grantsRole` (admin/superadmin → admin bundle, member → member bundle).
 *   - Pass B: every active membership is ensured to hold the built-in Role
 *     matching its role, keyed off grantsRole (member → Member, admin/owner → Admin).
 *   - Idempotent + cheap on a no-op (re-run inserts nothing, backfills nothing).
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

// `.select(...).lean()` chain used by both Group.find + UserOrganization.find.
const selectLean = (rows: unknown[]) => ({ select: () => ({ lean: () => Promise.resolve(rows) }) });

beforeEach(() => {
  jest.clearAllMocks();
  mockGroupUpdateOne.mockResolvedValue({});
});

describe('backfillRbacRoles', () => {
  it('backfills an empty built-in Role + a baseline-less member; is idempotent on re-run', async () => {
    // Pass A finds ONE empty built-in Role (the Member Role); Pass B maps the
    // org's built-in Roles (by grantsRole) and scans one member (u1, needs the
    // Member Role) + one admin (u2, already in the Admin Role).
    mockGroupFind.mockImplementation((filter: { $or?: unknown }) =>
      filter && filter.$or
        ? selectLean([{ _id: 'gD', grantsRole: 'member' }]) // empty built-ins
        : selectLean([
          { _id: 'gD', organizationId: 'org-1', grantsRole: 'member' },
          { _id: 'gA', organizationId: 'org-1', grantsRole: 'admin' },
        ]));
    mockUoFind.mockReturnValue(selectLean([
      { userId: 'u1', organizationId: 'org-1', role: 'member' },
      { userId: 'u2', organizationId: 'org-1', role: 'admin' },
    ]));
    // u1 gets inserted into the Member Role (new); u2 already in Admin (no-op).
    mockGmUpdateOne.mockImplementation((f: { userId: string }) =>
      Promise.resolve({ upsertedCount: f.userId === 'u1' ? 1 : 0 }));

    const summary = await backfillRbacRoles();

    expect(summary).toEqual({ orgsScanned: 1, rolesBackfilled: 1, assignmentsAdded: 1 });

    // Pass A: the empty Member Role got the member bundle (no admin grants).
    const setPerms = (mockGroupUpdateOne.mock.calls[0][1] as { $set: { permissions: string[] } }).$set.permissions;
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

    // ── Re-run: nothing empty, nothing to insert → a clean no-op. ─────────────
    jest.clearAllMocks();
    mockGroupUpdateOne.mockResolvedValue({});
    mockGroupFind.mockImplementation((filter: { $or?: unknown }) =>
      filter && filter.$or
        ? selectLean([]) // no empty built-ins this time
        : selectLean([
          { _id: 'gD', organizationId: 'org-1', grantsRole: 'member' },
          { _id: 'gA', organizationId: 'org-1', grantsRole: 'admin' },
        ]));
    mockUoFind.mockReturnValue(selectLean([
      { userId: 'u1', organizationId: 'org-1', role: 'member' },
      { userId: 'u2', organizationId: 'org-1', role: 'admin' },
    ]));
    mockGmUpdateOne.mockResolvedValue({ upsertedCount: 0 }); // all already present

    const rerun = await backfillRbacRoles();

    expect(rerun).toEqual({ orgsScanned: 1, rolesBackfilled: 0, assignmentsAdded: 0 });
    expect(mockGroupUpdateOne).not.toHaveBeenCalled(); // no Role bundle rewrites
  });

  it('skips memberships in an org with no built-in Roles (unseeded org)', async () => {
    mockGroupFind.mockImplementation((filter: { $or?: unknown }) =>
      filter && filter.$or ? selectLean([]) : selectLean([])); // no built-ins anywhere
    mockUoFind.mockReturnValue(selectLean([
      { userId: 'u1', organizationId: 'orphan-org', role: 'member' },
    ]));

    const summary = await backfillRbacRoles();

    expect(summary).toEqual({ orgsScanned: 1, rolesBackfilled: 0, assignmentsAdded: 0 });
    expect(mockGmUpdateOne).not.toHaveBeenCalled();
  });
});
