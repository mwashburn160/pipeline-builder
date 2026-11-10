// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Startup backfill for the single-source "Roles" RBAC model.
 *
 *   - Pass 0: CREATE any built-in Role an org's source list has but the database
 *     does not — in EVERY org. Both lists have grown: the system org's four job
 *     Roles, and `Team Lead` in every tenant. An org holding NO built-in at all
 *     is reported rather than invented for.
 *   - Pass A: RE-SYNC every built-in Role's bundle to the current source, and
 *     INVALIDATE the sessions of everyone holding one it rewrote — the same
 *     guarantee an interactive Role edit already gave.
 *   - Pass B: ensure every active membership holds the Role matching its coarse
 *     role, batched, and REPORT the orgs it could do nothing for.
 *   - Pass C: move the automation SERVICE ACCOUNTS `infra store-token`
 *     provisions off the org admin Role onto their least-privilege one, and
 *     never touch a person's assignment.
 *   - Idempotent + cheap on a no-op (re-run inserts nothing, rewrites nothing).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { SEED_BUNDLES, SYSTEM_ORG_JOB_BUNDLES } from '@pipeline-builder/api-core';
import { selectAwareLean, selectLean } from './helpers/query-chain.js';

const mockGroupFind = jest.fn<AnyFn>();
// Pass 0 and Pass A both write through `bulkWrite` now — one round trip instead
// of one per Role, because this job runs at every pod start and its row count is
// the whole fleet's.
const mockGroupBulkWrite = jest.fn<AnyFn>();
const mockGmBulkWrite = jest.fn<AnyFn>();
const mockAssignmentFind = jest.fn<AnyFn>();
const mockUserUpdateMany = jest.fn<AnyFn>();
const mockUoFind = jest.fn<AnyFn>();
const mockPublishUsersRevocation = jest.fn<AnyFn>();
const mockSaFind = jest.fn<AnyFn>();
const mockGmDeleteMany = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('mongoose', () => ({
  default: { Types: { ObjectId: class {} } },
  Types: { ObjectId: class {} },
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ recordAuditEvent: jest.fn() }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Role: {
    find: (...a: unknown[]) => mockGroupFind(...a),
    bulkWrite: (...a: unknown[]) => mockGroupBulkWrite(...a),
  },
  RoleAssignment: {
    bulkWrite: (...a: unknown[]) => mockGmBulkWrite(...a),
    find: (...a: unknown[]) => mockAssignmentFind(...a),
    deleteMany: (...a: unknown[]) => mockGmDeleteMany(...a),
  },
  ServiceAccount: { find: (...a: unknown[]) => mockSaFind(...a) },
  UserOrganization: { find: (...a: unknown[]) => mockUoFind(...a) },
  // This mock REPLACES the whole models barrel, so every name anything in the
  // import graph reads from it has to be present or ESM linking fails.
  User: { updateMany: (...a: unknown[]) => mockUserUpdateMany(...a) },
}));
// Pass A now invalidates the sessions of everyone holding a bundle it rewrote,
// exactly as an interactive Role edit does.
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishUserRevocation: jest.fn<AnyFn>(),
  publishUsersRevocation: (...a: unknown[]) => mockPublishUsersRevocation(...a),
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
const SYSTEM_ORG = '000000000000000000000001';
const TENANT = 'org-1';

/**
 * The system org's built-ins, by seeded name — DERIVED, because this is the
 * fixture (a fully-seeded org), not the assertion.
 *
 * It was a hand-written list, and adding a bundle meant remembering to extend
 * it or every Pass 0 case reported a spurious missing Role. Twice today it did.
 * The assertions below still name the Roles they expect, so nothing here is
 * tautological.
 */
const SYSTEM_ORG_ROLE_NAMES = [
  'Super Admin', 'Admin', 'Member', 'Pipeline Automation', 'Pipeline Registration',
  ...SYSTEM_ORG_JOB_BUNDLES.map((b) => SEED_BUNDLES[b].name),
];
/**
 * What EVERY org gets. `Team Lead` was here and is a TEMPLATE now, so a new org
 * seeds two Roles — which is why the Pass 0 case below uses a system-org Role to
 * demonstrate "the source grew" rather than the tenant one it originally used.
 */
const DEFAULT_ORG_ROLE_NAMES = ['Admin', 'Member', 'Pipeline Automation', 'Pipeline Registration'];

/**
 * Pass 0's view of a fleet with nothing missing: the system org fully seeded and
 * one fully-seeded tenant. Copied rather than imported because this suite mocks
 * the models barrel and api-core; `roles-service.test.ts` pins the source lists,
 * and a divergence shows up here as an unexpected `rolesCreated`.
 */
const FULLY_SEEDED = [
  ...SYSTEM_ORG_ROLE_NAMES.map((name) => ({ organizationId: SYSTEM_ORG, name })),
  ...DEFAULT_ORG_ROLE_NAMES.map((name) => ({ organizationId: TENANT, name })),
];

/**
 * Three `Role.find` calls, discriminated by their `.select()` — NOT by filter.
 *
 * Pass 0 scans EVERY org now (it used to be the system org only, which left a
 * tenant missing `Team Lead` with no carrier for `reports:write`), so its filter
 * is `{ system: true }` — identical to Pass A's. The projection is what separates
 * them, and it is the honest discriminator anyway: each pass asks for exactly the
 * fields it uses.
 *
 *   Pass 0 — select('organizationId name')
 *   Pass A — select('_id organizationId name grantsRole seedBundle permissions')
 *   Pass B — select('_id organizationId grantsRole'), filter carries grantsRole
 *
 * `pass0` defaults to a fully-seeded system org plus one fully-seeded tenant, so
 * a test only says otherwise when a MISSING Role is the thing it is testing.
 */


const findImpl = (passA: unknown[], passB: unknown[], pass0?: unknown[]) =>
  (filter: { grantsRole?: unknown }) => {
    if (filter?.grantsRole) return selectLean(passB);
    return selectAwareLean((projection) => (
      projection.includes('grantsRole') ? passA : (pass0 ?? FULLY_SEEDED)
    ));
  };

beforeEach(() => {
  jest.clearAllMocks();
  mockGroupBulkWrite.mockResolvedValue({ upsertedCount: 0 });
  mockGmBulkWrite.mockResolvedValue({ upsertedCount: 0 });
  mockAssignmentFind.mockReturnValue(selectLean([]));
  mockUserUpdateMany.mockResolvedValue({});
  mockPublishUsersRevocation.mockResolvedValue(undefined);
  mockSaFind.mockReturnValue(selectLean([]));
  mockGmDeleteMany.mockResolvedValue({ deletedCount: 0 });
});

describe('backfillRbacRoles — Pass 0: built-in Roles an org is missing', () => {
  // WHY THIS PASS EXISTS: Pass A can only fix a drifted BUNDLE. A Role added to
  // a source list AFTER a deployment was installed simply would not be there,
  // and both lists have grown that way.
  it('creates a missing Role in the SYSTEM org and in a TENANT, in one round trip', async () => {
    // `rolesCreated` is read from the driver's `upsertedCount`, so the mock has
    // to agree with the five ops the fixture below implies.
    mockGroupBulkWrite.mockResolvedValue({ upsertedCount: 5 });
    mockGroupFind.mockImplementation(findImpl([], [], [
      // The system org is missing FOUR of its job Roles; the tenant is missing
      // its Member Role. Both are "the source list grew (or a seed failed) and
      // Pass A cannot help, because it only re-syncs a Role that exists".
      ...['Super Admin', 'Admin', 'Member', 'Pipeline Automation', 'Pipeline Registration', 'Ecosystem Manager',
        'Publisher Verifier', 'Platform Observer', 'Platform Operator', 'Account Manager']
        .map((name) => ({ organizationId: SYSTEM_ORG, name })),
      ...['Admin', 'Pipeline Automation', 'Pipeline Registration'].map((name) => ({ organizationId: TENANT, name })),
    ]));
    mockUoFind.mockReturnValue(selectLean([]));

    const summary = await backfillRbacRoles();

    expect(summary.rolesCreated).toBe(5);
    expect(mockGroupBulkWrite).toHaveBeenCalledTimes(1);
    const ops = mockGroupBulkWrite.mock.calls[0][0] as Array<{ updateOne: { filter: Record<string, unknown>; update: { $setOnInsert: Record<string, unknown> }; upsert: boolean } }>;
    expect(ops.map((o) => [o.updateOne.filter.organizationId, o.updateOne.filter.name])).toEqual([
      [SYSTEM_ORG, 'Console Administrator'],
      [SYSTEM_ORG, 'Support Agent'],
      // Seed order is api-core's `SYSTEM_ORG_JOB_BUNDLES`, which is also the
      // order the staffing panel renders — one list, so the two cannot disagree.
      [SYSTEM_ORG, 'Support Lead'],
      [SYSTEM_ORG, 'Registry Operator'],
      [TENANT, 'Member'],
    ]);
    for (const o of ops) {
      // `upsert` + `$setOnInsert` is what makes this race-safe against a real
      // `seedDefaultRoles` landing at the same moment — `{ organizationId, name }`
      // is uniquely indexed, so the loser of the race writes nothing.
      expect(o.updateOne.upsert).toBe(true);
      expect(o.updateOne.update.$setOnInsert.system).toBe(true);
      expect(o.updateOne.update.$setOnInsert.permissions).toBeDefined();
    }
  });

  it('creates nothing when every org is already fully seeded', async () => {
    mockGroupFind.mockImplementation(findImpl([], []));
    mockUoFind.mockReturnValue(selectLean([]));
    const summary = await backfillRbacRoles();
    expect(summary.rolesCreated).toBe(0);
    expect(mockGroupBulkWrite).not.toHaveBeenCalled();
  });

  // An org with NO built-in Role is either mid-creation or broken. Inventing a
  // full set would race `seedDefaultRoles` — which also decides what the CREATOR
  // joins — and could leave an org whose owner holds nothing. So Pass 0 acts only
  // on orgs that were already seeded, and Pass B reports the rest.
  it('does NOT invent a Role set for an org that has none', async () => {
    mockGroupFind.mockImplementation(findImpl([], [], []));
    mockUoFind.mockReturnValue(selectLean([]));
    const summary = await backfillRbacRoles();
    expect(summary.rolesCreated).toBe(0);
    expect(mockGroupBulkWrite).not.toHaveBeenCalled();
  });
});

describe('backfillRbacRoles — Pass A: bundle re-sync and session invalidation', () => {
  const stale = { _id: 'gD', organizationId: TENANT, grantsRole: 'member', permissions: ['pipelines:read'] };
  const inSync = { _id: 'gA', organizationId: TENANT, grantsRole: 'admin', permissions: ADMIN_BUNDLE };

  it('rewrites a stale bundle, skips an in-sync one, and batches the writes', async () => {
    mockGroupBulkWrite.mockResolvedValue({ upsertedCount: 0 });
    mockGroupFind.mockImplementation(findImpl([stale, inSync], []));
    mockUoFind.mockReturnValue(selectLean([]));

    const summary = await backfillRbacRoles();

    expect(summary.rolesBackfilled).toBe(1);
    const ops = mockGroupBulkWrite.mock.calls[0][0] as Array<{ updateOne: { filter: { _id: string }; update: { $set: { permissions: string[] } } } }>;
    expect(ops).toHaveLength(1);
    expect(ops[0].updateOne.filter._id).toBe('gD');
    expect(ops[0].updateOne.update.$set.permissions.sort()).toEqual([...MEMBER_BUNDLE].sort());
  });

  // THE GAP THIS CLOSES. An interactive Role edit bumps `claimsVersion` for every
  // assignee and publishes a revocation, so a REMOVED permission stops working at
  // once. Pass A rewrote the same field and did neither — so a permission taken
  // out of a bundle stayed live in every in-flight token until it expired, while
  // the same change made by hand revoked immediately.
  it('bumps claimsVersion and publishes a revocation for everyone holding a rewritten bundle', async () => {
    mockGroupFind.mockImplementation(findImpl([stale], []));
    mockAssignmentFind.mockReturnValue(selectLean([
      { userId: 'u1' }, { userId: 'u2' }, { userId: 'u1' }, // duplicate: one bump
    ]));
    mockUoFind.mockReturnValue(selectLean([]));

    const summary = await backfillRbacRoles();

    expect(summary.claimsBumped).toBe(2);
    expect(mockUserUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ['u1', 'u2'] } },
      { $inc: { claimsVersion: 1 } },
    );
    expect(mockPublishUsersRevocation).toHaveBeenCalledWith(['u1', 'u2']);
    // USERS only — a service account holds no session and no `claimsVersion`;
    // its next token exchange re-derives the new permissions.
    expect((mockAssignmentFind.mock.calls[0][0] as { userId: unknown }).userId).toEqual({ $ne: null });
  });

  it('invalidates nothing when every bundle is already in sync', async () => {
    mockGroupFind.mockImplementation(findImpl([inSync], []));
    mockUoFind.mockReturnValue(selectLean([]));
    const summary = await backfillRbacRoles();
    expect(summary).toMatchObject({ rolesBackfilled: 0, claimsBumped: 0 });
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
    expect(mockPublishUsersRevocation).not.toHaveBeenCalled();
  });

  it('re-syncs a named-bundle Role to ITS bundle, not the one its grantsRole shares', async () => {
    mockGroupFind.mockImplementation(findImpl(
      [{ _id: 'gE', organizationId: SYSTEM_ORG, grantsRole: 'member', seedBundle: 'ecosystem_manager', permissions: [] }],
      [],
    ));
    mockUoFind.mockReturnValue(selectLean([]));
    await backfillRbacRoles();
    const ops = mockGroupBulkWrite.mock.calls[0][0] as Array<{ updateOne: { update: { $set: { permissions: string[] } } } }>;
    const written = ops[0].updateOne.update.$set.permissions;
    expect(written).toContain('plugins:moderate');
    expect(written).not.toEqual(expect.arrayContaining(['pipelines:write']));
  });
});

describe('backfillRbacRoles — Pass B: assignments, batched and reported', () => {
  it('batches every membership into one bulkWrite instead of a write each', async () => {
    mockGmBulkWrite.mockResolvedValue({ upsertedCount: 2 });
    mockGroupFind.mockImplementation(findImpl([], [
      { _id: 'gD', organizationId: TENANT, grantsRole: 'member' },
      { _id: 'gA', organizationId: TENANT, grantsRole: 'admin' },
    ]));
    mockUoFind.mockReturnValue(selectLean([
      { userId: 'u1', organizationId: TENANT, role: 'member' },
      { userId: 'u2', organizationId: TENANT, role: 'admin' },
      // `owner` takes the Admin Role — the owner bundle IS the admin bundle.
      { userId: 'u3', organizationId: TENANT, role: 'owner' },
    ]));

    const summary = await backfillRbacRoles();

    expect(mockGmBulkWrite).toHaveBeenCalledTimes(1);
    const ops = mockGmBulkWrite.mock.calls[0][0] as Array<{ updateOne: { filter: { userId: string; roleId: string } } }>;
    expect(ops.map((o) => [o.updateOne.filter.userId, o.updateOne.filter.roleId])).toEqual([
      ['u1', 'gD'], ['u2', 'gA'], ['u3', 'gA'],
    ]);
    expect(summary.assignmentsAdded).toBe(2);
  });

  // THE WORST STATE THIS JOB CAN MEET, and it used to be a bare `continue`: an
  // org with live members and no built-in Role has members holding NO
  // permissions at all — including its owner — which looks from the outside
  // exactly like "nobody has been granted anything yet".
  it('REPORTS an org with members but no built-in Role, rather than skipping in silence', async () => {
    mockGroupFind.mockImplementation(findImpl([], []));
    mockUoFind.mockReturnValue(selectLean([
      { userId: 'u9', organizationId: 'org-unseeded', role: 'owner' },
    ]));

    const summary = await backfillRbacRoles();

    expect(summary.orgsMissingBuiltinRoles).toBe(1);
    expect(summary.assignmentsAdded).toBe(0);
    expect(mockGmBulkWrite).not.toHaveBeenCalled();
  });

  it('reports an org missing only the SLOT a membership needs — the same hole, one wide', async () => {
    mockGroupFind.mockImplementation(findImpl([], [
      // Member Role present, Admin Role absent.
      { _id: 'gD', organizationId: TENANT, grantsRole: 'member' },
    ]));
    mockUoFind.mockReturnValue(selectLean([
      { userId: 'u1', organizationId: TENANT, role: 'admin' },
    ]));

    const summary = await backfillRbacRoles();

    expect(summary.orgsMissingBuiltinRoles).toBe(1);
    expect(mockGmBulkWrite).not.toHaveBeenCalled();
  });

  it('reports a clean fleet as clean', async () => {
    mockGroupFind.mockImplementation(findImpl([], [
      { _id: 'gD', organizationId: TENANT, grantsRole: 'member' },
    ]));
    mockUoFind.mockReturnValue(selectLean([
      { userId: 'u1', organizationId: TENANT, role: 'member' },
    ]));

    const summary = await backfillRbacRoles();

    expect(summary).toEqual({
      orgsScanned: 1,
      rolesCreated: 0,
      rolesBackfilled: 0,
      assignmentsAdded: 0,
      orgsMissingBuiltinRoles: 0,
      claimsBumped: 0,
      serviceAccountsNarrowed: 0,
      serviceAccountsUnnarrowed: 0,
    });
  });
});

describe('backfillRbacRoles — the machine Roles reach existing orgs (Pass 0 + Pass A)', () => {
  it('creates Pipeline Automation and Pipeline Registration in an org seeded before they existed', async () => {
    mockGroupBulkWrite.mockResolvedValue({ upsertedCount: 2 });
    mockGroupFind.mockImplementation(findImpl([], [], [
      ...SYSTEM_ORG_ROLE_NAMES.map((name) => ({ organizationId: SYSTEM_ORG, name })),
      // A tenant seeded before the machine Roles: Admin + Member only.
      ...['Admin', 'Member'].map((name) => ({ organizationId: TENANT, name })),
    ]));
    mockUoFind.mockReturnValue(selectLean([]));

    const summary = await backfillRbacRoles();

    expect(summary.rolesCreated).toBe(2);
    const ops = mockGroupBulkWrite.mock.calls[0][0] as Array<{ updateOne: { filter: Record<string, unknown>; update: { $setOnInsert: Record<string, unknown> } } }>;
    expect(ops.map((o) => [o.updateOne.filter.organizationId, o.updateOne.filter.name, o.updateOne.update.$setOnInsert.seedBundle]))
      .toEqual([
        [TENANT, 'Pipeline Automation', 'pipeline_automation'],
        [TENANT, 'Pipeline Registration', 'pipeline_registration'],
      ]);
    expect((ops[0].updateOne.update.$setOnInsert.permissions as string[]).sort()).toEqual(['pipelines:read', 'plugins:read']);
    expect(ops[1].updateOne.update.$setOnInsert.permissions).toEqual(['pipeline_registry:write']);
    // `member`: holding a machine Role confers no admin over the org.
    expect(ops.every((o) => o.updateOne.update.$setOnInsert.grantsRole === 'member')).toBe(true);
  });

  it('corrects a drifted Pipeline Automation bundle back to its two reads', async () => {
    mockGroupFind.mockImplementation(findImpl([
      { _id: 'gPA', organizationId: TENANT, grantsRole: 'member', seedBundle: 'pipeline_automation', permissions: ADMIN_BUNDLE },
    ], []));
    mockUoFind.mockReturnValue(selectLean([]));

    const summary = await backfillRbacRoles();

    expect(summary.rolesBackfilled).toBe(1);
    const ops = mockGroupBulkWrite.mock.calls[0][0] as Array<{ updateOne: { update: { $set: { permissions: string[] } } } }>;
    expect([...ops[0].updateOne.update.$set.permissions].sort()).toEqual(['pipelines:read', 'plugins:read']);
  });
});

describe('backfillRbacRoles — Pass C: automation service accounts off the admin Role', () => {
  /**
   * Pass C's three reads, told apart by FILTER: the admin-Role lookup carries
   * `_id`, the target lookup a `seedBundle` set; everything else is Pass 0/A/B.
   */
  const passCFind = (opts: { adminRoles: unknown[]; targets: unknown[] }) => {
    const rest = findImpl([], []);
    return (filter: { _id?: unknown; seedBundle?: unknown; grantsRole?: unknown }) => {
      if (filter?._id) return selectLean(opts.adminRoles);
      if (filter?.seedBundle && typeof filter.seedBundle === 'object') return selectLean(opts.targets);
      return rest(filter);
    };
  };
  const TARGETS = [
    { _id: 'gPA', organizationId: TENANT, seedBundle: 'pipeline_automation' },
    { _id: 'gPR', organizationId: TENANT, seedBundle: 'pipeline_registration' },
  ];
  const ACCOUNTS = [
    { _id: 'sa1', organizationId: TENANT, name: 'platform-automation' },
    { _id: 'sa2', organizationId: TENANT, name: 'reporting-ingest' },
    { _id: 'sa3', organizationId: TENANT, name: 'pipeline-register' },
  ];
  const assignmentsBy = (serviceAccountRows: unknown[]) => (filter: { serviceAccountId?: unknown }) =>
    selectLean(filter?.serviceAccountId ? serviceAccountRows : []);

  it('moves platform-automation onto Pipeline Automation and strips reporting-ingest to no Role', async () => {
    mockSaFind.mockReturnValue(selectLean(ACCOUNTS));
    mockAssignmentFind.mockImplementation(assignmentsBy([
      { _id: 'ra1', serviceAccountId: 'sa1', roleId: 'gA' },
      { _id: 'ra2', serviceAccountId: 'sa2', roleId: 'gA' },
      // Already least-privilege — the pass must leave it alone.
      { _id: 'ra3', serviceAccountId: 'sa3', roleId: 'gPR' },
    ]));
    mockGroupFind.mockImplementation(passCFind({ adminRoles: [{ _id: 'gA' }], targets: TARGETS }));
    mockUoFind.mockReturnValue(selectLean([]));

    const summary = await backfillRbacRoles();

    expect(summary).toMatchObject({ serviceAccountsNarrowed: 2, serviceAccountsUnnarrowed: 0 });
    // The grant: platform-automation → Pipeline Automation, upserted (race- and repeat-safe).
    const grants = mockGmBulkWrite.mock.calls[0][0] as Array<{ updateOne: { filter: Record<string, unknown>; upsert: boolean } }>;
    expect(grants.map((g) => g.updateOne.filter)).toEqual([{ serviceAccountId: 'sa1', roleId: 'gPA' }]);
    expect(grants[0].updateOne.upsert).toBe(true);
    // The revoke: exactly the two admin assignments, and only service-account rows.
    expect(mockGmDeleteMany).toHaveBeenCalledWith({ _id: { $in: ['ra1', 'ra2'] }, serviceAccountId: { $ne: null } });
    // GRANT before REVOKE, so a crash in between never leaves the account with nothing.
    expect(mockGmBulkWrite.mock.invocationCallOrder[0]).toBeLessThan(mockGmDeleteMany.mock.invocationCallOrder[0]);
  });

  it('is a no-op on a repeat run — nothing holds an admin Role any more', async () => {
    mockSaFind.mockReturnValue(selectLean(ACCOUNTS));
    mockAssignmentFind.mockImplementation(assignmentsBy([
      { _id: 'ra4', serviceAccountId: 'sa1', roleId: 'gPA' },
      { _id: 'ra3', serviceAccountId: 'sa3', roleId: 'gPR' },
    ]));
    mockGroupFind.mockImplementation(passCFind({ adminRoles: [], targets: TARGETS }));
    mockUoFind.mockReturnValue(selectLean([]));

    const summary = await backfillRbacRoles();

    expect(summary).toMatchObject({ serviceAccountsNarrowed: 0, serviceAccountsUnnarrowed: 0 });
    expect(mockGmBulkWrite).not.toHaveBeenCalled();
    expect(mockGmDeleteMany).not.toHaveBeenCalled();
  });

  it('never reads or writes a person’s assignment — human admins keep the Admin Role', async () => {
    mockSaFind.mockReturnValue(selectLean([ACCOUNTS[0]]));
    mockAssignmentFind.mockImplementation(assignmentsBy([{ _id: 'ra1', serviceAccountId: 'sa1', roleId: 'gA' }]));
    mockGroupFind.mockImplementation((filter: { _id?: unknown; seedBundle?: unknown; grantsRole?: unknown }) => {
      if (filter?._id) return selectLean([{ _id: 'gA' }]);
      if (filter?.seedBundle && typeof filter.seedBundle === 'object') return selectLean(TARGETS);
      return findImpl([], [{ _id: 'gA', organizationId: TENANT, grantsRole: 'admin' }])(filter);
    });
    // A human admin in the same org.
    mockUoFind.mockReturnValue(selectLean([{ userId: 'u1', organizationId: TENANT, role: 'admin' }]));

    await backfillRbacRoles();

    // Pass C asked for SERVICE-ACCOUNT assignments only…
    const passCRead = mockAssignmentFind.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((f) => 'serviceAccountId' in f);
    expect(passCRead).toEqual({ serviceAccountId: { $in: ['sa1'] } });
    // …removed only the account's row, never anything keyed by a user…
    expect(mockGmDeleteMany).toHaveBeenCalledTimes(1);
    expect(mockGmDeleteMany).toHaveBeenCalledWith({ _id: { $in: ['ra1'] }, serviceAccountId: { $ne: null } });
    // …and Pass B still ensured the human admin holds the Admin Role.
    const passB = mockGmBulkWrite.mock.calls
      .map((c) => c[0] as Array<{ updateOne: { filter: Record<string, unknown> } }>)
      .flat()
      .filter((op) => 'userId' in op.updateOne.filter);
    expect(passB.map((op) => op.updateOne.filter)).toEqual([{ userId: 'u1', roleId: 'gA' }]);
  });

  it('keeps an account on its admin Role, and REPORTS it, when the org has no Role to move it onto', async () => {
    mockSaFind.mockReturnValue(selectLean([ACCOUNTS[0]]));
    mockAssignmentFind.mockImplementation(assignmentsBy([{ _id: 'ra1', serviceAccountId: 'sa1', roleId: 'gA' }]));
    mockGroupFind.mockImplementation(passCFind({ adminRoles: [{ _id: 'gA' }], targets: [] }));
    mockUoFind.mockReturnValue(selectLean([]));

    const summary = await backfillRbacRoles();

    expect(summary).toMatchObject({ serviceAccountsNarrowed: 0, serviceAccountsUnnarrowed: 1 });
    expect(mockGmDeleteMany).not.toHaveBeenCalled();
  });
});
