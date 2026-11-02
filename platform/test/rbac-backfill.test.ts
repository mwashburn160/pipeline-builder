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

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { selectLean } from './helpers/query-chain.js';

const mockGroupFind = jest.fn<AnyFn>();
const mockGroupUpdateOne = jest.fn<AnyFn>();
const mockGroupCreate = jest.fn<AnyFn>();
const mockGmUpdateOne = jest.fn<AnyFn>();
const mockUoFind = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('mongoose', () => ({
  default: { Types: { ObjectId: class {} } },
  Types: { ObjectId: class {} },
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Role: {
    find: (...a: unknown[]) => mockGroupFind(...a),
    updateOne: (...a: unknown[]) => mockGroupUpdateOne(...a),
    create: (...a: unknown[]) => mockGroupCreate(...a),
  },
  RoleAssignment: { updateOne: (...a: unknown[]) => mockGmUpdateOne(...a) },
  UserOrganization: { find: (...a: unknown[]) => mockUoFind(...a) },
  // This mock REPLACES the whole models barrel, so every name anything in the
  // import graph reads from it has to be present or ESM linking fails. `User`
  // is one of those.
  User: {},
}));

const { backfillRbacRoles } = await import('../src/services/rbac-backfill.js');
// The permission bundles the re-sync targets (mirrors api-core ROLE_PERMISSIONS).
const { ROLE_PERMISSIONS } = (await import('@pipeline-builder/api-core')) as unknown as {
  ROLE_PERMISSIONS: { member: string[]; admin: string[] };
};
const MEMBER_BUNDLE = [...ROLE_PERMISSIONS.member];
const ADMIN_BUNDLE = [...ROLE_PERMISSIONS.admin];

// What Pass 0 reads back from a FULLY-SEEDED system org — `SYSTEM_ORG_ROLES` in
// roles-service, which `roles-service.test.ts` pins against `seedDefaultRoles`.
// Copied rather than imported because this suite mocks the models barrel and
// api-core, so importing roles-service here would drag its graph in. The copy is
// self-correcting: add a built-in Role and these tests report `rolesCreated: 1`
// and fail, naming the Role to add below.
const ALL_SYSTEM_ORG_ROLES = [
  'Super Admin', 'Admin', 'Member', 'Team Lead', 'Ecosystem Manager',
  'Platform Operator', 'Account Manager', 'Console Administrator', 'Support Agent',
].map((name) => ({ name }));

// `.select(...).lean()` chain used by both Role.find + UserOrganization.find.

// Three passes, three `Role.find` filters, discriminated by shape:
//   Pass 0 — `{ organizationId: SYSTEM_ORG_ID, system: true }` (carries an org)
//   Pass A — `{ system: true }` (no org, no grantsRole)
//   Pass B — carries `grantsRole`
// `pass0` defaults to a fully-seeded system org, so a test only says otherwise
// when a missing Role is the thing it is testing.
const findImpl = (passA: unknown[], passB: unknown[], pass0?: unknown[]) =>
  (filter: { grantsRole?: unknown; organizationId?: unknown }) => {
    if (filter?.organizationId) return selectLean(pass0 ?? ALL_SYSTEM_ORG_ROLES);
    return selectLean(filter?.grantsRole ? passB : passA);
  };

beforeEach(() => {
  jest.clearAllMocks();
  mockGroupUpdateOne.mockResolvedValue({});
  mockGroupCreate.mockResolvedValue([]);
});

describe('backfillRbacRoles — Pass 0: missing system-org built-ins', () => {
  // The case this pass exists for: a deployment that was installed before a Role
  // was added to the source. Pass A cannot help — it only re-syncs the bundle of
  // a Role that exists — so without this the Role's permissions, all
  // system-org-only and therefore ungrantable by any custom Role, have no
  // carrier at all and the job cannot be staffed.
  it('creates only the Roles that are absent, with their bundle and system:true', async () => {
    mockGroupFind.mockImplementation(findImpl([], [], [
      { name: 'Super Admin' }, { name: 'Admin' }, { name: 'Member' },
      { name: 'Team Lead' }, { name: 'Ecosystem Manager' },
    ]));
    mockUoFind.mockReturnValue(selectLean([]));

    const summary = await backfillRbacRoles();

    expect(summary.rolesCreated).toBe(4);
    const created = mockGroupCreate.mock.calls[0][0] as Array<{ name: string; system: boolean; permissions: string[]; seedBundle?: string }>;
    expect(created.map((r) => r.name)).toEqual([
      'Platform Operator', 'Account Manager', 'Console Administrator', 'Support Agent',
    ]);
    // Created WITH its bundle, so the Role is usable before Pass A next runs,
    // and `system: true` so Pass A then owns keeping it current.
    for (const r of created) {
      expect(r.system).toBe(true);
      expect(r.permissions.length).toBeGreaterThan(0);
      expect(r.seedBundle).toBeDefined();
    }
  });

  it('creates nothing when the system org is already fully seeded', async () => {
    mockGroupFind.mockImplementation(findImpl([], []));
    mockUoFind.mockReturnValue(selectLean([]));
    const summary = await backfillRbacRoles();
    expect(summary.rolesCreated).toBe(0);
    expect(mockGroupCreate).not.toHaveBeenCalled();
  });

  // An install that never created a system org has nothing to backfill. Creating
  // Roles for an absent org would leave orphans that `seedDefaultRoles` then
  // duplicates, so an empty read means "no system org", not "all nine missing".
  it('creates nothing when the system org does not exist yet', async () => {
    mockGroupFind.mockImplementation(findImpl([], [], []));
    mockUoFind.mockReturnValue(selectLean([]));
    const summary = await backfillRbacRoles();
    expect(summary.rolesCreated).toBe(0);
    expect(mockGroupCreate).not.toHaveBeenCalled();
  });
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

    expect(summary).toEqual({ orgsScanned: 1, rolesBackfilled: 1, assignmentsAdded: 1, rolesCreated: 0 });

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

  it('re-syncs the system org Ecosystem Manager to ITS bundle, and keeps it out of the Member slot', async () => {
    const { ECOSYSTEM_MANAGER_PERMISSIONS } = (await import('@pipeline-builder/api-core')) as unknown as {
      ECOSYSTEM_MANAGER_PERMISSIONS: string[];
    };
    mockGroupFind.mockImplementation(findImpl(
      [
        { _id: 'gD', grantsRole: 'member', permissions: MEMBER_BUNDLE },
        // Stale Ecosystem Manager: shares grantsRole 'member' but carries a named bundle.
        { _id: 'gE', grantsRole: 'member', seedBundle: 'ecosystem_manager', permissions: ['plugins:read'] },
      ],
      [{ _id: 'gD', organizationId: 'sys', grantsRole: 'member' }],
    ));
    mockUoFind.mockReturnValue(selectLean([{ userId: 'u1', organizationId: 'sys', role: 'member' }]));
    mockGmUpdateOne.mockResolvedValue({ upsertedCount: 0 });

    await backfillRbacRoles();

    // Only the Ecosystem Manager is rewritten — to its own bundle, never the member bundle.
    expect(mockGroupUpdateOne).toHaveBeenCalledTimes(1);
    const call = mockGroupUpdateOne.mock.calls[0] as [{ _id: string }, { $set: { permissions: string[] } }];
    expect(call[0]).toEqual({ _id: 'gE' });
    expect([...call[1].$set.permissions].sort()).toEqual([...ECOSYSTEM_MANAGER_PERMISSIONS].sort());
    // Pass B's built-in lookup excludes named-bundle Roles, so no member is ever
    // auto-assigned the Ecosystem Manager.
    expect(mockGroupFind).toHaveBeenCalledWith(expect.objectContaining({ grantsRole: { $in: ['member', 'admin'] }, seedBundle: null }));
    expect(mockGmUpdateOne).not.toHaveBeenCalledWith(expect.objectContaining({ roleId: 'gE' }), expect.anything(), expect.anything());
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

    expect(summary).toEqual({ orgsScanned: 1, rolesBackfilled: 0, assignmentsAdded: 0, rolesCreated: 0 });
    expect(mockGroupUpdateOne).not.toHaveBeenCalled(); // no Role bundle rewrites
  });

  it('re-syncs a built-in Role whose stored list is missing entirely', async () => {
    // A Role doc with no `permissions` field at all still gets the current bundle
    // (a Role with no list at all is the most-stale case).
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

    expect(summary).toEqual({ orgsScanned: 1, rolesBackfilled: 0, assignmentsAdded: 0, rolesCreated: 0 });
    expect(mockGmUpdateOne).not.toHaveBeenCalled();
  });
});
