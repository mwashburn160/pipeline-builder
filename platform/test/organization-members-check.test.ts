// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for OrgMembersService.isActiveMember — the lightweight membership
 * probe backing the message service's per-user DM validation. Returns true only
 * for an ACTIVE membership, false when absent, and false (never throws) on a
 * malformed user id that trips a Mongoose CastError.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUoExists = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ expandOrgScope: async (id: string) => [id] }));
jest.unstable_mockModule('../src/helpers/seats.js', () => ({
  seatCapacityAvailable: jest.fn(async () => true),
  seatCapacityStillWithinCap: jest.fn(async () => true),
  userHasSeatInAccount: jest.fn(async () => false),
}));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({ ensureBaselineRole: jest.fn(async () => undefined), assignBuiltinAdminRole: jest.fn(async () => true), recomputeUserOrgRole: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));
jest.unstable_mockModule('../src/utils/regex.js', () => ({ escapeRegex: (s: string) => s }));

jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: {},
  User: {},
  UserOrganization: { exists: (...a: unknown[]) => mockUoExists(...a) },
  RoleAssignment: {},
}));

const { orgMembersService } = await import('../src/services/org-members-service.js');

describe('OrgMembersService.isActiveMember', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns true when an active membership exists', async () => {
    mockUoExists.mockResolvedValue({ _id: 'uo-1' });

    const ok = await orgMembersService.isActiveMember('org-1', 'user-42');

    expect(ok).toBe(true);
    expect(mockUoExists).toHaveBeenCalledWith({ userId: 'user-42', organizationId: 'org-1', isActive: true });
  });

  it('returns false when no active membership exists', async () => {
    mockUoExists.mockResolvedValue(null);
    expect(await orgMembersService.isActiveMember('org-1', 'user-42')).toBe(false);
  });

  it('returns false (never throws) on a CastError for a malformed user id', async () => {
    mockUoExists.mockRejectedValue(new Error('Cast to ObjectId failed'));
    expect(await orgMembersService.isActiveMember('org-1', 'not-an-objectid')).toBe(false);
  });
});
