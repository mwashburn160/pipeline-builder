// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `listOrganizations` annotates every membership row with `childOrgCount` — the
 * single "does this org parent teams" signal the frontend uses to show or hide
 * its hierarchy surfaces (team lists, rollup toggles, per-team breakdowns) — and
 * `parentOrgName`, and appends a `viaAncestor` row for each team the user may
 * enter on admin authority inherited from its parent.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockMembershipsFind = jest.fn();
const mockOrgFind = jest.fn();
const mockChildrenFind = jest.fn();
const mockParentFind = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {},
  UserPreferences: {},
  UserOrganization: {
    find: (...a: unknown[]) => ({ sort: () => ({ lean: () => mockMembershipsFind(...a) }) }),
  },
  // Three distinct reads, told apart by their filter: the member orgs
  // (`_id` + `parentOrgId`-less), their live children (`parentOrgId`), and the
  // names of parents the user isn't in (`_id` only, after the others).
  Organization: {
    find: (q: Record<string, unknown>) => ({
      select: () => ({
        lean: () => ('parentOrgId' in q ? mockChildrenFind(q) : mockOrgFind.mock.calls.length === 0 ? mockOrgFind(q) : mockParentFind(q)),
      }),
    }),
  },
}));
jest.unstable_mockModule('../src/services/api-key-service.js', () => ({ apiKeyService: {} }));
jest.unstable_mockModule('../src/services/auth-service.js', () => ({ authService: {} }));
jest.unstable_mockModule('../src/services/user-cascade.js', () => ({ deleteUserCascade: jest.fn() }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
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

const OTHER_ROOT = 'dddddddddddddddddddddddd';
const OTHER_TEAM = 'eeeeeeeeeeeeeeeeeeeeeeee';
const TEAM2 = 'ffffffffffffffffffffffff';

describe('userProfileService.listOrganizations — childOrgCount + parentOrgName', () => {
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
    // ROOT has two live teams; the user is a member of TEAM only.
    mockChildrenFind.mockResolvedValue([
      { _id: TEAM, name: 'Team', slug: 'team', parentOrgId: ROOT, tier: 'team' },
      { _id: TEAM2, name: 'Team Two', slug: 'team-two', parentOrgId: ROOT, tier: 'team' },
    ] as never);
    mockParentFind.mockResolvedValue([] as never);
  });

  it('reports each org\'s live team count, 0 for orgs with none', async () => {
    const rows = await userProfileService.listOrganizations('u1');
    const byId = new Map(rows.map((r) => [r.organizationId, r]));
    expect(byId.get(ROOT)?.childOrgCount).toBe(2);
    expect(byId.get(TEAM)?.childOrgCount).toBe(0);
    expect(byId.get(SOLO)?.childOrgCount).toBe(0);
    expect(byId.get(TEAM)?.parentOrgId).toBe(ROOT);
  });

  it('reads only LIVE children of the caller\'s orgs, by the string parent id', async () => {
    await userProfileService.listOrganizations('u1');
    expect(mockChildrenFind).toHaveBeenCalledWith({ parentOrgId: { $in: [ROOT, TEAM, SOLO] }, deletedAt: null });
  });

  it('names a team\'s parent from orgs already in hand — no extra read when the user is in the parent', async () => {
    const rows = await userProfileService.listOrganizations('u1');
    expect(rows.find((r) => r.organizationId === TEAM)?.parentOrgName).toBe('Root');
    expect(rows.find((r) => r.organizationId === ROOT)?.parentOrgName).toBeUndefined();
    expect(mockParentFind).not.toHaveBeenCalled();
  });

  it('reads the name of a parent the user is NOT a member of', async () => {
    mockMembershipsFind.mockResolvedValue([{ organizationId: OTHER_TEAM, role: 'member', isActive: true }] as never);
    mockOrgFind.mockResolvedValue([{ _id: OTHER_TEAM, name: 'Other team', parentOrgId: OTHER_ROOT, tier: 'team' }] as never);
    mockChildrenFind.mockResolvedValue([] as never);
    mockParentFind.mockResolvedValue([{ _id: OTHER_ROOT, name: 'Other root' }] as never);

    const rows = await userProfileService.listOrganizations('u1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ parentOrgId: OTHER_ROOT, parentOrgName: 'Other root' });
    expect(mockParentFind).toHaveBeenCalledWith({ _id: { $in: [OTHER_ROOT] } });
  });

  it('skips every other read when the user has no memberships', async () => {
    mockMembershipsFind.mockResolvedValue([] as never);
    await expect(userProfileService.listOrganizations('u1')).resolves.toEqual([]);
    expect(mockChildrenFind).not.toHaveBeenCalled();
  });
});

describe('userProfileService.listOrganizations — inherited-authority (viaAncestor) teams', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParentFind.mockResolvedValue([] as never);
  });

  it('adds a viaAncestor admin row for each live team of an org the user administers, without a membership', async () => {
    mockMembershipsFind.mockResolvedValue([
      { organizationId: ROOT, role: 'owner', isActive: true },
      { organizationId: TEAM, role: 'member', isActive: true },
    ] as never);
    mockOrgFind.mockResolvedValue([
      { _id: ROOT, name: 'Root', tier: 'team' },
      { _id: TEAM, name: 'Team', parentOrgId: ROOT, tier: 'team' },
    ] as never);
    mockChildrenFind.mockResolvedValue([
      { _id: TEAM, name: 'Team', slug: 'team', parentOrgId: ROOT, tier: 'team' },
      { _id: TEAM2, name: 'Team Two', slug: 'team-two', parentOrgId: ROOT, tier: 'team' },
    ] as never);

    const rows = await userProfileService.listOrganizations('u1');

    // The membership rows come first, unchanged (TEAM keeps its own row, no dupe).
    expect(rows.map((r) => r.organizationId)).toEqual([ROOT, TEAM, TEAM2]);
    expect(rows.find((r) => r.organizationId === TEAM)?.viaAncestor).toBeUndefined();
    expect(rows[2]).toEqual({
      organizationId: TEAM2,
      organizationName: 'Team Two',
      slug: 'team-two',
      role: 'admin',
      isActive: true,
      parentOrgId: ROOT,
      parentOrgName: 'Root',
      tier: 'team',
      childOrgCount: 0,
      viaAncestor: true,
    });
  });

  it('adds none for a plain member, an inactive admin, or an admin of a soft-deleted parent', async () => {
    for (const [membership, root] of [
      [{ organizationId: ROOT, role: 'member', isActive: true }, { _id: ROOT, name: 'Root', tier: 'team' }],
      [{ organizationId: ROOT, role: 'admin', isActive: false }, { _id: ROOT, name: 'Root', tier: 'team' }],
      [{ organizationId: ROOT, role: 'owner', isActive: true }, { _id: ROOT, name: 'Root', tier: 'team', deletedAt: new Date() }],
    ] as const) {
      mockOrgFind.mockClear();
      mockMembershipsFind.mockResolvedValue([membership] as never);
      mockOrgFind.mockResolvedValue([root] as never);
      mockChildrenFind.mockResolvedValue([{ _id: TEAM2, name: 'Team Two', parentOrgId: ROOT, tier: 'team' }] as never);

      const rows = await userProfileService.listOrganizations('u1');
      expect(rows.map((r) => r.organizationId)).toEqual([ROOT]);
    }
  });
});
