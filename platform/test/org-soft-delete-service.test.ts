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
  db: { update: jest.fn(), delete: jest.fn(), select: jest.fn(() => mockSelectChain) },
  schema: new Proxy({}, { get: (_t, name) => ({ orgId: `${String(name)}.org_id` }) }),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => Promise<T>): Promise<T> => fn(),
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

jest.unstable_mockModule('../src/models/audit-event.js', () => ({ __esModule: true, default: { deleteMany: jest.fn(), find: jest.fn(() => ({ lean: () => [] })), create: jest.fn() } }));
jest.unstable_mockModule('../src/models/invitation.js', () => ({ __esModule: true, default: { deleteMany: jest.fn(), find: jest.fn(() => ({ lean: () => [] })) } }));
jest.unstable_mockModule('../src/models/org-idp-config.js', () => ({ __esModule: true, default: { deleteMany: jest.fn() } }));
jest.unstable_mockModule('../src/models/organization.js', () => ({
  __esModule: true,
  default: { findById: (...a: unknown[]) => mockOrgFindById(...a), updateOne: (...a: unknown[]) => mockOrgUpdateOne(...a) },
}));
jest.unstable_mockModule('../src/models/deleted-org-snapshot.js', () => ({ __esModule: true, default: { create: (...a: unknown[]) => mockSnapshotCreate(...a) } }));
jest.unstable_mockModule('../src/models/user.js', () => ({ __esModule: true, default: { updateMany: (...a: unknown[]) => mockUserUpdateMany(...a) } }));
jest.unstable_mockModule('../src/models/user-organization.js', () => ({ __esModule: true, default: { find: (...a: unknown[]) => mockUserOrgFind(...a) } }));

jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (fn: (s: unknown) => Promise<unknown>) => fn({ /* fake session */ }),
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));

const { softDeleteOrg, ORG_ALREADY_DELETED, ORG_SNAPSHOT_FAILED, ORG_NOT_FOUND, SYSTEM_ORG_DELETE_FORBIDDEN } =
  await import('../src/services/org-cascade-service.js');

const SYSTEM_ORG_ID = '000000000000000000000001';

beforeEach(() => {
  jest.clearAllMocks();
  mockSelectChain.from.mockReturnValue(mockSelectChain);
  mockSelectChain.where.mockResolvedValue([]);
  // Live org (not yet soft-deleted).
  mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => ({ _id: 'org-acme', name: 'Acme', deletedAt: null }) }) });
  mockOrgUpdateOne.mockReturnValue({ session: () => Promise.resolve({}) });
  mockSnapshotCreate.mockResolvedValue({ _id: 'snap-1' });
  mockUserOrgFind.mockReturnValue({ select: () => ({ session: () => ({ lean: () => Promise.resolve([{ userId: 'u1' }, { userId: 'u2' }]) }) }) });
  mockUserUpdateMany.mockReturnValue({ session: () => Promise.resolve({}) });
});

describe('softDeleteOrg', () => {
  it('writes a recovery snapshot, tombstones the org, and bumps active members tokenVersion', async () => {
    const result = await softDeleteOrg('org-acme', SYSTEM_ORG_ID, 'admin-1');

    // Snapshot persisted (name denormalized, deletedBy captured).
    expect(mockSnapshotCreate).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-acme', name: 'Acme', deletedBy: 'admin-1' }));

    // Tombstone set: deletedAt + purgeAfter (~7 days out).
    const [filter, update] = mockOrgUpdateOne.mock.calls[0] as [any, any];
    expect(filter).toEqual({ _id: 'org-acme' });
    expect(update.$set.deletedAt).toBeInstanceOf(Date);
    expect(update.$set.purgeAfter).toBeInstanceOf(Date);
    const windowMs = update.$set.purgeAfter.getTime() - update.$set.deletedAt.getTime();
    expect(Math.abs(windowMs - 7 * 86400_000)).toBeLessThan(5000);

    // All active members invalidated.
    const [uFilter, uUpdate] = mockUserUpdateMany.mock.calls[0] as [any, any];
    expect(uFilter).toEqual({ _id: { $in: ['u1', 'u2'] } });
    expect(uUpdate.$inc).toEqual({ tokenVersion: 1 });
    expect(uUpdate.$unset).toEqual({ refreshToken: '' });

    expect(result.membersInvalidated).toBe(2);
    expect(result.snapshotId).toBe('snap-1');
    expect(result.purgeAfter).toBeInstanceOf(Date);
  });

  it('ABORTS (throws ORG_SNAPSHOT_FAILED) and does NOT tombstone when the snapshot cannot be persisted', async () => {
    mockSnapshotCreate.mockRejectedValue(new Error('mongo down'));

    await expect(softDeleteOrg('org-acme', SYSTEM_ORG_ID, 'admin-1')).rejects.toThrow(ORG_SNAPSHOT_FAILED);

    // Critically: the org must NOT be tombstoned and no sessions cut.
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
