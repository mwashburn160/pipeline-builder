// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `listOrganizations` annotates every membership row with `childOrgCount` — the
 * single "does this org parent teams" signal the frontend uses to show or hide
 * its hierarchy surfaces (team lists, rollup toggles, per-team breakdowns).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockMembershipsFind = jest.fn();
const mockOrgFind = jest.fn();
const mockAggregate = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {},
  UserPreferences: {},
  UserOrganization: {
    find: (...a: unknown[]) => ({ sort: () => ({ lean: () => mockMembershipsFind(...a) }) }),
  },
  Organization: {
    find: (...a: unknown[]) => ({ select: () => ({ lean: () => mockOrgFind(...a) }) }),
    aggregate: (...a: unknown[]) => mockAggregate(...a),
  },
}));
jest.unstable_mockModule('../src/services/api-key-service.js', () => ({ apiKeyService: {} }));
jest.unstable_mockModule('../src/services/auth-service.js', () => ({ authService: {} }));
jest.unstable_mockModule('../src/services/user-cascade.js', () => ({ deleteUserCascade: jest.fn() }));
jest.unstable_mockModule('../src/helpers/active-org-info.js', () => ({ loadActiveOrgInfo: jest.fn() }));
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishUserRevocation: jest.fn(),
  publishUserDeletionRevocation: jest.fn(),
}));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({ withMongoTransaction: jest.fn() }));

const { userProfileService } = await import('../src/services/user-profile-service.js');

const ROOT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const TEAM = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const SOLO = 'cccccccccccccccccccccccc';

describe('userProfileService.listOrganizations — childOrgCount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMembershipsFind.mockResolvedValue([
      { organizationId: ROOT, role: 'owner', isActive: true },
      { organizationId: TEAM, role: 'member', isActive: true },
      { organizationId: SOLO, role: 'admin', isActive: true },
    ] as never);
    mockOrgFind.mockResolvedValue([
      { _id: ROOT, name: 'Root', tier: 'team' },
      { _id: TEAM, name: 'Team', parentOrgId: ROOT, tier: 'team' },
      { _id: SOLO, name: 'Solo', tier: 'pro' },
    ] as never);
    mockAggregate.mockResolvedValue([{ _id: ROOT, n: 2 }] as never);
  });

  it('reports each org\'s live team count, 0 for orgs with none', async () => {
    const rows = await userProfileService.listOrganizations('u1');
    const byId = new Map(rows.map((r) => [r.organizationId, r]));
    expect(byId.get(ROOT)?.childOrgCount).toBe(2);
    expect(byId.get(TEAM)?.childOrgCount).toBe(0);
    expect(byId.get(SOLO)?.childOrgCount).toBe(0);
    expect(byId.get(TEAM)?.parentOrgId).toBe(ROOT);
  });

  it('counts only live children of the caller\'s orgs, by the string parent id', async () => {
    await userProfileService.listOrganizations('u1');
    const [pipeline] = mockAggregate.mock.calls[0] as [Array<Record<string, any>>];
    expect(pipeline[0].$match).toEqual({ parentOrgId: { $in: [ROOT, TEAM, SOLO] }, deletedAt: null });
  });

  it('skips the count query entirely when the user has no memberships', async () => {
    mockMembershipsFind.mockResolvedValue([] as never);
    await expect(userProfileService.listOrganizations('u1')).resolves.toEqual([]);
    expect(mockAggregate).not.toHaveBeenCalled();
  });
});
