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
const mockAssignmentFind = jest.fn();
const mockRoleFind = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/services/user-ecosystem-privacy.js', () => ({
  // The GDPR erasure the delete paths call POST-COMMIT. Mocked here because the
  // real module VALUE-imports `@pipeline-builder/pipeline-data` and the metrics
  // registry, which drags the real `src/config/index.ts` into a suite that never
  // loaded it -- and that surfaces as "SECRET_ENCRYPTION_KEY is required in
  // production", naming something entirely unrelated to the actual cause. The
  // erasure has its own suite (`user-ecosystem-privacy.test.ts`).
  anonymizeUserEcosystemContent: jest.fn(async () => 0),
}));

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
  // The two reads behind `roleNames`: the user's assignments, then the Roles
  // they name. A BARE OBJECT here replaces the whole namespace, so a new import
  // in the service under test makes this suite stop LOADING ("does not provide
  // an export named Role") rather than fail an assertion — which is why these
  // are added alongside the import and not after it.
  RoleAssignment: {
    find: (...a: unknown[]) => ({ select: () => ({ lean: () => mockAssignmentFind(...a) }) }),
  },
  Role: {
    find: (...a: unknown[]) => ({ select: () => ({ lean: () => mockRoleFind(...a) }) }),
  },
}));
jest.unstable_mockModule('../src/services/api-key-service.js', () => ({ apiKeyService: {} }));
jest.unstable_mockModule('../src/services/auth-service.js', () => ({ authService: {} }));
jest.unstable_mockModule('../src/services/user-cascade.js', () => ({ deleteUserCascade: jest.fn() }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/active-org-info.js', () => ({ loadActiveOrgInfo: jest.fn() }));
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishSessionSlotRevocation: async () => true,
  publishAccessKeyRevocation: async () => true,
  publishUserRevocation: jest.fn(),
  publishUserDeletionRevocation: jest.fn(),
}));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({ withMongoTransaction: jest.fn() }));

// The password-policy helper reads platform config at import; these suites
// don't exercise password rules, so it is stubbed like the other services.
jest.unstable_mockModule('../src/helpers/password-policy.js', () => ({
  assertNewPasswordAcceptable: jest.fn(async () => undefined),
}));

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
    mockAssignmentFind.mockResolvedValue([] as never);
    mockRoleFind.mockResolvedValue([] as never);
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
    mockAssignmentFind.mockResolvedValue([] as never);
    mockRoleFind.mockResolvedValue([] as never);
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
      // No membership row means no Roles: the authority IS the parent's, and
      // the switcher labels such a row "via parent" rather than with a Role.
      roleNames: [],
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

/**
 * `roleNames` and `requiresMfa` — what the ORG SWITCHER labels each row with.
 *
 * The switcher used to label every row from `role`, the coarse
 * owner/admin/member word, which is the one field that grants nothing on its
 * own (permissions come only from the assigned Roles). These rows are what let
 * it name the Roles instead, and flag an org whose MFA policy would refuse an
 * aal-1 switch BEFORE the click rather than afterwards as an error.
 */
describe('userProfileService.listOrganizations — roleNames + requiresMfa', () => {
  const ROLE_A = '111111111111111111111111';
  const ROLE_B = '222222222222222222222222';

  beforeEach(() => {
    jest.clearAllMocks();
    mockMembershipsFind.mockResolvedValue([
      { organizationId: ROOT, role: 'owner', isActive: true },
      { organizationId: SOLO, role: 'member', isActive: true },
    ] as never);
    mockOrgFind.mockResolvedValue([
      { _id: ROOT, name: 'Root', tier: 'team' },
      { _id: SOLO, name: 'Solo', tier: 'pro' },
    ] as never);
    mockChildrenFind.mockResolvedValue([] as never);
    mockParentFind.mockResolvedValue([] as never);
    mockAssignmentFind.mockResolvedValue([] as never);
    mockRoleFind.mockResolvedValue([] as never);
  });

  it('names the Roles held in each org, sorted and deduped, bucketed by org', async () => {
    mockAssignmentFind.mockResolvedValue([
      { roleId: ROLE_B, organizationId: ROOT },
      { roleId: ROLE_A, organizationId: ROOT },
      { roleId: ROLE_A, organizationId: SOLO },
    ] as never);
    mockRoleFind.mockResolvedValue([
      { _id: ROLE_A, name: 'Admin' },
      { _id: ROLE_B, name: 'Release Manager' },
    ] as never);

    const rows = await userProfileService.listOrganizations('u1');
    const byId = new Map(rows.map((r) => [r.organizationId, r]));
    expect(byId.get(ROOT)?.roleNames).toEqual(['Admin', 'Release Manager']);
    expect(byId.get(SOLO)?.roleNames).toEqual(['Admin']);
  });

  it('queries the assignments by userId and the Roles by the ids they name — two reads for the whole list', async () => {
    mockAssignmentFind.mockResolvedValue([{ roleId: ROLE_A, organizationId: ROOT }] as never);
    mockRoleFind.mockResolvedValue([{ _id: ROLE_A, name: 'Admin' }] as never);

    await userProfileService.listOrganizations('u1');
    expect(mockAssignmentFind).toHaveBeenCalledTimes(1);
    expect(mockAssignmentFind).toHaveBeenCalledWith({ userId: 'u1' });
    expect(mockRoleFind).toHaveBeenCalledTimes(1);
    expect(mockRoleFind).toHaveBeenCalledWith({ _id: { $in: [ROLE_A] } });
  });

  it('skips the Role read entirely when the user holds no assignments', async () => {
    const rows = await userProfileService.listOrganizations('u1');
    expect(mockRoleFind).not.toHaveBeenCalled();
    for (const r of rows) expect(r.roleNames).toEqual([]);
  });

  // A dangling assignment (its Role was deleted) would otherwise render as a
  // blank chip in the switcher.
  it('drops an assignment whose Role no longer exists rather than naming it blank', async () => {
    mockAssignmentFind.mockResolvedValue([
      { roleId: ROLE_A, organizationId: ROOT },
      { roleId: ROLE_B, organizationId: ROOT },
    ] as never);
    mockRoleFind.mockResolvedValue([{ _id: ROLE_A, name: 'Admin' }] as never);

    const rows = await userProfileService.listOrganizations('u1');
    expect(rows.find((r) => r.organizationId === ROOT)?.roleNames).toEqual(['Admin']);
  });

  it('flags an org whose OWN adminActionsRequireMfa is on', async () => {
    mockOrgFind.mockResolvedValue([
      { _id: ROOT, name: 'Root', tier: 'team', adminActionsRequireMfa: true },
      { _id: SOLO, name: 'Solo', tier: 'pro' },
    ] as never);

    const rows = await userProfileService.listOrganizations('u1');
    const byId = new Map(rows.map((r) => [r.organizationId, r]));
    expect(byId.get(ROOT)?.requiresMfa).toBe(true);
    // Absent, not false — a row without the policy is unchanged in the payload.
    expect(byId.get(SOLO)?.requiresMfa).toBeUndefined();
  });

  it("flags a team whose PARENT's policy is in force over it", async () => {
    mockMembershipsFind.mockResolvedValue([
      { organizationId: ROOT, role: 'owner', isActive: true },
      { organizationId: TEAM, role: 'member', isActive: true },
    ] as never);
    mockOrgFind.mockResolvedValue([
      { _id: ROOT, name: 'Root', tier: 'team', adminActionsRequireMfa: true },
      { _id: TEAM, name: 'Team', parentOrgId: ROOT, tier: 'team' },
    ] as never);

    const rows = await userProfileService.listOrganizations('u1');
    expect(rows.find((r) => r.organizationId === TEAM)?.requiresMfa).toBe(true);
  });

  // An inherited-authority row has no membership, so it has no Roles: the
  // authority IS the parent's, and the switcher says "via parent" instead.
  it('gives an inherited-authority row no Roles at all', async () => {
    mockMembershipsFind.mockResolvedValue([
      { organizationId: ROOT, role: 'admin', isActive: true },
    ] as never);
    mockOrgFind.mockResolvedValue([{ _id: ROOT, name: 'Root', tier: 'team' }] as never);
    mockChildrenFind.mockResolvedValue([
      { _id: TEAM2, name: 'Team Two', slug: 'team-two', parentOrgId: ROOT, tier: 'team' },
    ] as never);
    mockAssignmentFind.mockResolvedValue([{ roleId: ROLE_A, organizationId: ROOT }] as never);
    mockRoleFind.mockResolvedValue([{ _id: ROLE_A, name: 'Admin' }] as never);

    const rows = await userProfileService.listOrganizations('u1');
    const inherited = rows.find((r) => r.organizationId === TEAM2);
    expect(inherited?.viaAncestor).toBe(true);
    expect(inherited?.roleNames).toEqual([]);
    // The membership row still names its Role.
    expect(rows.find((r) => r.organizationId === ROOT)?.roleNames).toEqual(['Admin']);
  });
});
