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

jest.unstable_mockModule('../src/middleware/quota.js', () => ({ getOrganizationQuotaStatus: jest.fn(), updateQuotaLimits: jest.fn(), QuotaType: {} }));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { quota: { tier: {} } } }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a), findOne: (...a: unknown[]) => mockOrgFindOne(...a) },
  User: { updateMany: (...a: unknown[]) => mockUserUpdateMany(...a), updateOne: jest.fn() },
  UserOrganization: { find: (...a: unknown[]) => mockUserOrgFind(...a), deleteMany: jest.fn() },
  Invitation: { distinct: () => ({ session: () => Promise.resolve([]) }) },
  OrgIdpConfig: { find: jest.fn(), exists: jest.fn() },
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
