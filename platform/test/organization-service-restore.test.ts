// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `organizationService.restore` (reverses a soft-delete within the
 * retention window) and the soft-delete mutation guard on `update` (a
 * soft-deleted org is treated as not-found for mutations).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockOrgFindById = jest.fn();
const mockOrgFindOne = jest.fn();
const mockUserOrgFind = jest.fn();
const mockUserUpdateMany = jest.fn();
const mockPrepareTeamRestore = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockOrgFind = jest.fn();
const mockGetOrgName = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  decryptSecret: jest.fn(),
  encryptSecret: jest.fn(),
  isEncryptedBlob: jest.fn(() => false),
  QUOTA_TIERS: { developer: { limits: {} }, pro: { limits: {} }, team: { limits: {} }, enterprise: { limits: {} } },
}));

jest.unstable_mockModule('mongoose', () => {
  class Schema {
    constructor() { /* no-op */ }
    index() { /* no-op */ }
    method() { /* no-op */ }
    pre() { /* no-op */ }
    post() { /* no-op */ }
    virtual() { return this; }
    set() { /* no-op */ }
    static Types = { Mixed: class {}, ObjectId: class {} };
  }
  const startSession = jest.fn(async () => ({
    withTransaction: async (cb: () => Promise<unknown>) => cb(),
    endSession: jest.fn(),
  }));
  return { default: { startSession }, Types: { ObjectId: class {} }, Schema, models: {}, model: jest.fn() };
});

jest.unstable_mockModule('../src/middleware/quota.js', () => ({ getOrganizationQuotaStatus: jest.fn(), QuotaType: {} }));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { quota: { tier: {} } } }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  getOrgName: (...a: unknown[]) => mockGetOrgName(...a),
  expandOrgScope: jest.fn(),
  resolveOrgLineage: jest.fn(),
}));
jest.unstable_mockModule('../src/services/org-hierarchy-service.js', () => ({
  orgHierarchyService: { prepareTeamRestore: (...a: unknown[]) => mockPrepareTeamRestore(...a) },
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: {
    findById: (...a: unknown[]) => mockOrgFindById(...a),
    findOne: (...a: unknown[]) => mockOrgFindOne(...a),
    find: (...a: unknown[]) => mockOrgFind(...a),
  },
  User: { updateMany: (...a: unknown[]) => mockUserUpdateMany(...a), updateOne: jest.fn() },
  UserOrganization: { find: (...a: unknown[]) => mockUserOrgFind(...a), deleteMany: jest.fn(), countDocuments: jest.fn(async () => 0) },
  Invitation: { distinct: () => ({ session: () => Promise.resolve([]) }) },
  OrgIdpConfig: { find: jest.fn(), exists: jest.fn(async () => null) },
  Role: { create: jest.fn(), find: jest.fn(), findOne: jest.fn(), exists: jest.fn(), deleteMany: jest.fn() },
  RoleAssignment: { create: jest.fn(), find: jest.fn(), exists: jest.fn(), deleteMany: jest.fn() },
}));

const { organizationService } = await import('../src/services/organization-service.js');

beforeEach(() => {
  jest.clearAllMocks();
  mockUserOrgFind.mockReturnValue({ select: () => ({ session: () => ({ lean: () => Promise.resolve([{ userId: 'u1' }, { userId: 'u2' }]) }) }) });
  mockUserUpdateMany.mockReturnValue({ session: () => Promise.resolve({}) });
});

describe('organizationService.restore', () => {
  it('clears the tombstone and bumps active members tokenVersion', async () => {
    const save = jest.fn();
    const doc: any = { _id: { toString: () => 'org-acme' }, name: 'Acme', deletedAt: new Date(), purgeAfter: new Date(), save };
    mockOrgFindOne.mockReturnValue({ session: () => Promise.resolve(doc) });

    const result = await organizationService.restore('org-acme');

    // Only soft-deleted orgs are targeted.
    expect(mockOrgFindOne).toHaveBeenCalledWith({ _id: 'org-acme', deletedAt: { $ne: null } });
    // Tombstone cleared + saved.
    expect(doc.deletedAt).toBeNull();
    expect(doc.purgeAfter).toBeNull();
    expect(save).toHaveBeenCalled();
    // Members re-invalidated so re-issued tokens see the org live again.
    expect(mockUserUpdateMany).toHaveBeenCalledWith({ _id: { $in: ['u1', 'u2'] } }, { $inc: { tokenVersion: 1 } });
    expect(result).toEqual({ id: 'org-acme', name: 'Acme', membersInvalidated: 2 });
  });

  it('excludes the acting admin so restore never logs out the restorer', async () => {
    const save = jest.fn();
    const doc: any = { _id: { toString: () => 'org-acme' }, name: 'Acme', deletedAt: new Date(), purgeAfter: new Date(), save };
    mockOrgFindOne.mockReturnValue({ session: () => Promise.resolve(doc) });

    // u1 is the actor performing the restore.
    const result = await organizationService.restore('org-acme', 'u1');

    // Only the OTHER member (u2) is invalidated; u1's session stays valid.
    expect(mockUserUpdateMany).toHaveBeenCalledWith({ _id: { $in: ['u2'] } }, { $inc: { tokenVersion: 1 } });
    expect(result).toEqual({ id: 'org-acme', name: 'Acme', membersInvalidated: 1 });
  });

  it('a TEAM restore runs the parent/seat checks and re-syncs tier + entitlements before un-tombstoning', async () => {
    const save = jest.fn();
    const set = jest.fn();
    const doc: any = { _id: { toString: () => 'team-1' }, name: 'Blue', parentOrgId: 'root-1', deletedAt: new Date(), purgeAfter: new Date(), save, set };
    mockOrgFindOne.mockReturnValue({ session: () => Promise.resolve(doc) });
    mockPrepareTeamRestore.mockResolvedValue({ tier: 'enterprise', featureEntitlements: ['sso'] });

    await organizationService.restore('team-1', 'admin-1');

    expect(mockPrepareTeamRestore).toHaveBeenCalledWith('team-1', 'root-1', expect.anything());
    expect(set).toHaveBeenCalledWith({ tier: 'enterprise', featureEntitlements: ['sso'] });
    expect(doc.deletedAt).toBeNull();
    expect(save).toHaveBeenCalled();
  });

  it('a refused TEAM restore leaves the tombstone in place', async () => {
    const save = jest.fn();
    const doc: any = { _id: { toString: () => 'team-1' }, parentOrgId: 'root-1', deletedAt: new Date(), purgeAfter: new Date(), save, set: jest.fn() };
    mockOrgFindOne.mockReturnValue({ session: () => Promise.resolve(doc) });
    mockPrepareTeamRestore.mockRejectedValue(new Error('ORG_SEAT_LIMIT'));

    await expect(organizationService.restore('team-1', 'admin-1')).rejects.toThrow('ORG_SEAT_LIMIT');
    expect(doc.deletedAt).not.toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('a ROOT restore does not run the team checks', async () => {
    const doc: any = { _id: { toString: () => 'org-acme' }, name: 'Acme', deletedAt: new Date(), purgeAfter: new Date(), save: jest.fn() };
    mockOrgFindOne.mockReturnValue({ session: () => Promise.resolve(doc) });
    await organizationService.restore('org-acme');
    expect(mockPrepareTeamRestore).not.toHaveBeenCalled();
  });

  it('returns null when there is no soft-deleted org (already purged / never deleted)', async () => {
    mockOrgFindOne.mockReturnValue({ session: () => Promise.resolve(null) });

    const result = await organizationService.restore('gone');
    expect(result).toBeNull();
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });
});

describe('organizationService.update — soft-delete guard', () => {
  it('treats a soft-deleted org as not-found (returns null, no write)', async () => {
    const save = jest.fn();
    mockOrgFindById.mockResolvedValue({ _id: { toString: () => 'org-acme' }, name: 'Acme', deletedAt: new Date(), save });

    const result = await organizationService.update('org-acme', { name: 'New' });
    expect(result).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('organizationService.getById — includeHierarchy (sysadmin detail)', () => {
  const membersChain = { populate: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) }) };

  beforeEach(() => {
    (mockUserOrgFind as any).mockReturnValue(membersChain);
  });

  it('adds the parent\'s name and the LIVE direct teams', async () => {
    mockOrgFindById.mockReturnValue({ populate: () => ({ lean: async () => ({ _id: { toString: () => 'team-1' }, name: 'Blue', parentOrgId: 'root-1', createdAt: new Date(), updatedAt: new Date() }) }) });
    mockGetOrgName.mockResolvedValue('Root');
    mockOrgFind.mockReturnValue({ select: () => ({ sort: () => ({ lean: async () => [] }) }) });

    const org = await organizationService.getById('team-1', { includeHierarchy: true });

    expect(org).toMatchObject({ parentOrgId: 'root-1', parentOrgName: 'Root', teams: [] });
    expect(mockOrgFind).toHaveBeenCalledWith({ parentOrgId: 'team-1', deletedAt: null });
  });

  it('lists a root\'s live teams; omits parentOrgName for a root', async () => {
    mockOrgFindById.mockReturnValue({ populate: () => ({ lean: async () => ({ _id: { toString: () => 'root-1' }, name: 'Root', createdAt: new Date(), updatedAt: new Date() }) }) });
    mockGetOrgName.mockResolvedValue(undefined);
    mockOrgFind.mockReturnValue({ select: () => ({ sort: () => ({ lean: async () => [{ _id: 't1', name: 'Blue' }, { _id: 't2', name: 'Red' }] }) }) });

    const org = await organizationService.getById('root-1', { includeHierarchy: true });

    expect(org).toMatchObject({ parentOrgId: null, teams: [{ orgId: 't1', orgName: 'Blue' }, { orgId: 't2', orgName: 'Red' }] });
    expect(org).not.toHaveProperty('parentOrgName');
  });

  it('omits the hierarchy fields when not asked', async () => {
    mockOrgFindById.mockReturnValue({ populate: () => ({ lean: async () => ({ _id: { toString: () => 'root-1' }, name: 'Root' }) }) });
    const org = await organizationService.getById('root-1');
    expect(org).not.toHaveProperty('teams');
    expect(mockOrgFind).not.toHaveBeenCalled();
  });
});
