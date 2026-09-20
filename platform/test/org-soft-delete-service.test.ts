// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `softDeleteOrg` — the snapshot + tombstone + session-cut half of the
 * org soft-delete subsystem.
 *
 * Invariants:
 *   - A durable recovery snapshot is written BEFORE the org is tombstoned.
 *   - If the snapshot can't be persisted, the soft-delete ABORTS (throws
 *     ORG_SNAPSHOT_FAILED) and the org is NOT tombstoned.
 *   - On success it sets `deletedAt`/`purgeAfter` and bumps every active
 *     member's `tokenVersion` — it runs NO destructive cascade.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: () => ({ delete: jest.fn() }),
  getServiceAuthHeader: () => 'Bearer test-service-token',
}));

// pipeline-data: exportOrg reads through these — return empty so the snapshot
// resolves to an (empty) blob without a real DB.
const mockSelectChain = { from: jest.fn(), where: jest.fn() };
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({ update: jest.fn(), delete: jest.fn(), select: jest.fn(() => mockSelectChain) }),
  schema: new Proxy({}, { get: (_t, name) => ({ orgId: `${String(name)}.org_id` }) }),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => Promise<T>): Promise<T> => fn(),
  // Shared row-level soft-delete window (SOFT_DELETE_RETENTION_DAYS, 30d) — the
  // FLOOR under the org's own purge deadline.
  softDeleteRetentionMs: () => 30 * 24 * 60 * 60 * 1000,
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    quota: { serviceHost: 'quota', servicePort: 3000 },
    billing: { serviceHost: 'billing', servicePort: 3000 },
    organization: { deletionRetentionDays: 7 },
  },
}));

const mockOrgFindById = jest.fn();
const mockOrgUpdateOne = jest.fn();
const mockSnapshotCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUserOrgFind = jest.fn();
const mockUserUpdateMany = jest.fn();
const mockUserFind = jest.fn();
const mockPatUpdateMany = jest.fn();
const mockServiceAccountFind = jest.fn<(...a: unknown[]) => unknown>();

const auditExportQuery = { sort: () => auditExportQuery, limit: () => auditExportQuery, lean: async () => [] };
/** Mongoose query stub for the STRICT snapshot export, which now reads every
 *  collection the teardown removes (a missing one aborts the soft-delete). */
const emptyFind = () => queryChain([]);
/** Chainable query stub: `.select()`, `.session()`, `.sort()`, `.limit()`, `.lean()`. */
const queryChain = (rows: unknown[]) => {
  const c: any = { lean: async () => rows, select: () => c, session: () => c, sort: () => c, limit: () => c };
  return c;
};
jest.unstable_mockModule('../src/models/audit-event.js', () => ({ __esModule: true, default: { deleteMany: jest.fn(), find: jest.fn(() => auditExportQuery), create: jest.fn() } }));
jest.unstable_mockModule('../src/models/invitation.js', () => ({ __esModule: true, default: { deleteMany: jest.fn(), find: jest.fn(() => ({ lean: () => [] })) } }));
jest.unstable_mockModule('../src/models/org-idp-config.js', () => ({ __esModule: true, default: { deleteMany: jest.fn(), find: emptyFind } }));
jest.unstable_mockModule('../src/models/idp-group-mapping.js', () => ({ __esModule: true, default: { deleteMany: jest.fn(), find: emptyFind } }));
jest.unstable_mockModule('../src/models/org-domain.js', () => ({ __esModule: true, default: { deleteMany: jest.fn(), find: emptyFind } }));
jest.unstable_mockModule('../src/models/join-request.js', () => ({ __esModule: true, default: { deleteMany: jest.fn(), find: emptyFind } }));
jest.unstable_mockModule('../src/models/saml-session.js', () => ({ __esModule: true, default: { deleteMany: jest.fn(), find: emptyFind } }));
jest.unstable_mockModule('../src/models/role.js', () => ({ __esModule: true, default: { find: emptyFind } }));
jest.unstable_mockModule('../src/models/organization.js', () => ({
  __esModule: true,
  default: { findById: (...a: unknown[]) => mockOrgFindById(...a), updateOne: (...a: unknown[]) => mockOrgUpdateOne(...a) },
}));
jest.unstable_mockModule('../src/models/deleted-org-snapshot.js', () => ({ __esModule: true, default: { create: (...a: unknown[]) => mockSnapshotCreate(...a) } }));
jest.unstable_mockModule('../src/models/user.js', () => ({
  __esModule: true,
  default: {
    updateMany: (...a: unknown[]) => mockUserUpdateMany(...a),
    // Sessions working in the org on INHERITED authority (no membership row) are
    // found by `lastActiveOrgId` and cut too.
    find: (...a: unknown[]) => mockUserFind(...a),
  },
}));
jest.unstable_mockModule('../src/models/user-organization.js', () => ({ __esModule: true, default: { find: (...a: unknown[]) => mockUserOrgFind(...a) } }));
jest.unstable_mockModule('../src/models/personal-access-token.js', () => ({
  __esModule: true,
  default: { updateMany: (...a: unknown[]) => mockPatUpdateMany(...a), find: emptyFind },
}));
// Service accounts (#2): the tombstone also revokes their keys — they hold no
// session, so the members' tokenVersion bump cannot reach them.
jest.unstable_mockModule('../src/models/service-account.js', () => ({
  __esModule: true,
  default: { find: (...a: unknown[]) => mockServiceAccountFind(...a) },
}));
jest.unstable_mockModule('../src/models/role-assignment.js', () => ({ __esModule: true, default: { deleteMany: jest.fn(), find: emptyFind } }));

jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (fn: (s: unknown) => Promise<unknown>) => fn({ /* fake session */ }),
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));

const { softDeleteOrg, orgPurgeRetentionMs } = await import('../src/services/org-cascade-service.js');
const { ORG_ALREADY_DELETED, ORG_SNAPSHOT_FAILED, ORG_NOT_FOUND, SYSTEM_ORG_DELETE_FORBIDDEN } = await import('../src/services/org-errors.js');

const SYSTEM_ORG_ID = '000000000000000000000001';

beforeEach(() => {
  jest.clearAllMocks();
  mockSelectChain.from.mockReturnValue(mockSelectChain);
  mockSelectChain.where.mockResolvedValue([]);
  // Live org (not yet soft-deleted).
  mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => ({ _id: 'org-acme', name: 'Acme', deletedAt: null }) }) });
  mockOrgUpdateOne.mockReturnValue({ session: () => Promise.resolve({}) });
  mockSnapshotCreate.mockResolvedValue({ _id: 'snap-1' });
  // Chainable: the session cut-off reads `.select().session().lean()`, while the
  // snapshot export reads the same collection with a plain `.lean()`.
  mockUserOrgFind.mockReturnValue(queryChain([{ userId: 'u1' }, { userId: 'u2' }]));
  mockUserUpdateMany.mockReturnValue({ session: () => Promise.resolve({}) });
  // No one working in the org on inherited (parent-admin) authority by default.
  mockUserFind.mockReturnValue(queryChain([]));
  mockPatUpdateMany.mockReturnValue({ session: () => Promise.resolve({}) });
  // One service account in the org, holding one live key.
  mockServiceAccountFind.mockReturnValue(queryChain([{ _id: 'sa-1' }]));
});

describe('softDeleteOrg', () => {
  it('writes a recovery snapshot, tombstones the org, and bumps active members tokenVersion', async () => {
    const result = await softDeleteOrg('org-acme', SYSTEM_ORG_ID, 'admin-1');

    // Snapshot persisted (name denormalized, deletedBy captured).
    expect(mockSnapshotCreate).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-acme', name: 'Acme', deletedBy: 'admin-1' }));

    // Tombstone set: deletedAt + purgeAfter. The deadline is the GREATER of the
    // org window (7d here) and the shared row-level soft-delete window (30d) —
    // the org must outlive the rows this same cascade tombstones, or they are
    // orphaned for the difference.
    const [filter, update] = mockOrgUpdateOne.mock.calls[0] as [any, any];
    expect(filter).toEqual({ _id: 'org-acme' });
    expect(update.$set.deletedAt).toBeInstanceOf(Date);
    expect(update.$set.purgeAfter).toBeInstanceOf(Date);
    const windowMs = update.$set.purgeAfter.getTime() - update.$set.deletedAt.getTime();
    expect(Math.abs(windowMs - 30 * 86400_000)).toBeLessThan(5000);

    // All active members invalidated.
    const [uFilter, uUpdate] = mockUserUpdateMany.mock.calls[0] as [any, any];
    expect(uFilter).toEqual({ _id: { $in: ['u1', 'u2'] } });
    expect(uUpdate.$inc).toEqual({ tokenVersion: 1 });
    expect(uUpdate.$set).toEqual({ refreshSessions: [] });

    expect(result.membersInvalidated).toBe(2);
    expect(result.snapshotId).toBe('snap-1');
    expect(result.purgeAfter).toBeInstanceOf(Date);

    // Members' PATs SCOPED TO THIS ORG are revoked in the same txn — a PAT's
    // authority is decoupled from tokenVersion, so the bump above wouldn't reach
    // it. Scoped by organizationId so PATs for other (live) orgs are untouched.
    const [patFilter, patUpdate] = mockPatUpdateMany.mock.calls[0] as [any, any];
    expect(patFilter).toEqual({ userId: { $in: ['u1', 'u2'] }, organizationId: 'org-acme', revoked: false });
    expect(patUpdate.$set.revoked).toBe(true);
    expect(patUpdate.$set.revokedAt).toBeInstanceOf(Date);
  });

  it('also cuts sessions working in the org on INHERITED authority (pinned by lastActiveOrgId), once each', async () => {
    // u2 is a member AND pinned; parent-admin has no membership row at all.
    mockUserFind.mockReturnValue({ select: () => ({ session: () => ({ lean: () => Promise.resolve([{ _id: 'u2' }, { _id: 'parent-admin' }]) }) }) });

    const result = await softDeleteOrg('org-acme', SYSTEM_ORG_ID, 'admin-1');

    expect(mockUserFind).toHaveBeenCalledWith({ lastActiveOrgId: 'org-acme' });
    const [uFilter] = mockUserUpdateMany.mock.calls[0] as [any, any];
    expect(uFilter).toEqual({ _id: { $in: ['u1', 'u2', 'parent-admin'] } });
    expect(result.membersInvalidated).toBe(3);
  });

  it('does NOT revoke member PATs when the org has no active members', async () => {
    mockUserOrgFind.mockReturnValue(queryChain([]));
    mockServiceAccountFind.mockReturnValue(queryChain([]));

    const result = await softDeleteOrg('org-acme', SYSTEM_ORG_ID, 'admin-1');

    expect(result.membersInvalidated).toBe(0);
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
    expect(mockPatUpdateMany).not.toHaveBeenCalled();
  });

  it('revokes the org SERVICE ACCOUNTS\' keys too — they hold no session to invalidate', async () => {
    await softDeleteOrg('org-acme', SYSTEM_ORG_ID, 'admin-1');

    // A service account has no `tokenVersion`, so the member bump above cannot
    // reach it; without this its automation would keep writing to a tombstoned
    // org for the whole retention window.
    const saCall = mockPatUpdateMany.mock.calls.find((c: any) => 'serviceAccountId' in (c[0] ?? {})) as [any, any];
    expect(saCall).toBeDefined();
    expect(saCall[0]).toEqual({ serviceAccountId: { $in: ['sa-1'] }, revoked: false });
    expect(saCall[1].$set.revoked).toBe(true);
  });

  it('keeps the accounts themselves — a restore within the window needs them', async () => {
    await softDeleteOrg('org-acme', SYSTEM_ORG_ID, 'admin-1');
    // Only an UPDATE (revoke) touched the key records; nothing deleted the
    // accounts, whose Roles the operator keeps on restore.
    expect(mockPatUpdateMany).toHaveBeenCalled();
  });

  it('ABORTS (throws ORG_SNAPSHOT_FAILED) and does NOT tombstone when the snapshot cannot be persisted', async () => {
    mockSnapshotCreate.mockRejectedValue(new Error('mongo down'));

    await expect(softDeleteOrg('org-acme', SYSTEM_ORG_ID, 'admin-1')).rejects.toThrow(ORG_SNAPSHOT_FAILED);

    // Critically: the org must NOT be tombstoned and no sessions cut.
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });

  it('ABORTS and does NOT tombstone when any store cannot be read — the snapshot must be complete', async () => {
    mockSelectChain.where.mockRejectedValueOnce(new Error('relation down'));

    await expect(softDeleteOrg('org-acme', SYSTEM_ORG_ID, 'admin-1')).rejects.toThrow(ORG_SNAPSHOT_FAILED);

    expect(mockSnapshotCreate).not.toHaveBeenCalled();
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });

  it('rejects a second soft-delete of an already-tombstoned org', async () => {
    mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => ({ _id: 'org-acme', name: 'Acme', deletedAt: new Date() }) }) });
    await expect(softDeleteOrg('org-acme', SYSTEM_ORG_ID, 'admin-1')).rejects.toThrow(ORG_ALREADY_DELETED);
    expect(mockSnapshotCreate).not.toHaveBeenCalled();
  });

  it('404s an unknown org', async () => {
    mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => null }) });
    await expect(softDeleteOrg('missing', SYSTEM_ORG_ID, 'admin-1')).rejects.toThrow(ORG_NOT_FOUND);
  });

  it('refuses to soft-delete the system org', async () => {
    await expect(softDeleteOrg(SYSTEM_ORG_ID, SYSTEM_ORG_ID, 'admin-1')).rejects.toThrow(SYSTEM_ORG_DELETE_FORBIDDEN);
  });
});

/**
 * `ORG_DELETION_RETENTION_DAYS` (7d) was shorter than the row-level
 * `SOFT_DELETE_RETENTION_DAYS` (30d) the same cascade stamps onto every
 * Postgres row it tombstones — so the org document, its quota record and its
 * subscription were destroyed on day 7 while the rows they own sat tombstoned
 * until day 30, belonging to an org that no longer existed.
 */
describe('orgPurgeRetentionMs', () => {
  it('is floored at the shared row-level soft-delete window', () => {
    // Config says 7 days; the row window (mocked at 30d) wins.
    expect(orgPurgeRetentionMs()).toBe(30 * 86400_000);
  });

  it('never purges the org before the rows it cascades', async () => {
    await softDeleteOrg('org-acme', SYSTEM_ORG_ID, 'admin-1');
    const [, update] = mockOrgUpdateOne.mock.calls[0] as [any, any];
    const window = update.$set.purgeAfter.getTime() - update.$set.deletedAt.getTime();
    expect(window).toBeGreaterThanOrEqual(30 * 86400_000 - 5000);
  });
});
