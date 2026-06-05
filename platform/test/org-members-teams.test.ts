// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the org → team membership helpers on `orgMembersService`:
 *   - listMemberTeams: descendant teams annotated with the member's membership.
 *   - bulkAddMemberToTeams: add one user to several subtree teams, idempotent,
 *     rejecting targets outside the context org's subtree.
 */

const mockOrgFind = jest.fn();
const mockUserFindById = jest.fn();
const mockUserFindOne = jest.fn();
const mockUserOrgFind = jest.fn();
const mockUserOrgFindOne = jest.fn();
const mockUserOrgCreate = jest.fn();
const mockExpandOrgScope = jest.fn();

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('mongoose', () => {
  class Schema {
    constructor() { /* no-op */ }
    index() { /* no-op */ }
    static Types = { Mixed: class {}, ObjectId: class {} };
  }
  return { default: { Types: { ObjectId: class {} } }, Types: { ObjectId: class {} }, Schema, models: {}, model: jest.fn() };
});

jest.mock('../src/helpers/controller-helper', () => ({ toOrgId: (id: string) => id }));
jest.mock('../src/helpers/org-hierarchy', () => ({ expandOrgScope: (...a: unknown[]) => mockExpandOrgScope(...a) }));
// Run the transaction body immediately with a stub session.
jest.mock('../src/utils/mongo-tx', () => ({
  withMongoTransaction: (fn: (s: unknown) => unknown) => fn({ id: 'session' }),
}));

jest.mock('../src/models', () => ({
  Organization: { find: (...a: unknown[]) => mockOrgFind(...a) },
  User: {
    findById: (...a: unknown[]) => mockUserFindById(...a),
    findOne: (...a: unknown[]) => mockUserFindOne(...a),
    updateOne: jest.fn(),
  },
  UserOrganization: {
    find: (...a: unknown[]) => mockUserOrgFind(...a),
    findOne: (...a: unknown[]) => mockUserOrgFindOne(...a),
    create: (...a: unknown[]) => mockUserOrgCreate(...a),
  },
}));

import { orgMembersService, OM_USER_NOT_FOUND, OM_TARGETS_OUT_OF_SCOPE } from '../src/services/org-members-service';

/** Organization.find(...).select(...).lean() */
const orgFindReturns = (rows: unknown[]) =>
  mockOrgFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(rows) }) });
/** UserOrganization.find(...).select(...).lean() */
const userOrgFindReturns = (rows: unknown[]) =>
  mockUserOrgFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(rows) }) });
/** X.findOne/findById(...).session(...) */
const sessionReturns = (doc: unknown) => ({ session: () => Promise.resolve(doc) });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('orgMembersService.listMemberTeams', () => {
  it('annotates each descendant team with the member\'s membership, excluding the context org', async () => {
    mockExpandOrgScope.mockResolvedValue(['ctx', 'teamB', 'teamA']);
    orgFindReturns([
      { _id: 'teamA', name: 'Alpha', parentOrgId: 'ctx' },
      { _id: 'teamB', name: 'Bravo', parentOrgId: 'ctx' },
    ]);
    userOrgFindReturns([{ organizationId: 'teamA', role: 'member', isActive: true }]);

    const { teams } = await orgMembersService.listMemberTeams('ctx', 'u1');

    // Context org filtered out; sorted by name.
    expect(teams.map(t => t.orgId)).toEqual(['teamA', 'teamB']);
    expect(teams[0]).toMatchObject({ orgId: 'teamA', orgName: 'Alpha', isMember: true, role: 'member', isActive: true });
    expect(teams[1]).toMatchObject({ orgId: 'teamB', orgName: 'Bravo', isMember: false });
    expect(teams[1].role).toBeUndefined();
  });

  it('returns [] for a flat org with no descendant teams', async () => {
    mockExpandOrgScope.mockResolvedValue(['ctx']);
    const { teams } = await orgMembersService.listMemberTeams('ctx', 'u1');
    expect(teams).toEqual([]);
    expect(mockOrgFind).not.toHaveBeenCalled();
  });
});

describe('orgMembersService.listTeams', () => {
  it('returns the descendant team roster (no member annotation), sorted by name', async () => {
    mockExpandOrgScope.mockResolvedValue(['ctx', 'teamB', 'teamA']);
    orgFindReturns([
      { _id: 'teamB', name: 'Bravo', parentOrgId: 'ctx' },
      { _id: 'teamA', name: 'Alpha', parentOrgId: 'ctx' },
    ]);

    const { teams } = await orgMembersService.listTeams('ctx');

    expect(teams).toEqual([
      { orgId: 'teamA', orgName: 'Alpha', parentOrgId: 'ctx' },
      { orgId: 'teamB', orgName: 'Bravo', parentOrgId: 'ctx' },
    ]);
    // No membership lookup for the plain roster.
    expect(mockUserOrgFind).not.toHaveBeenCalled();
  });

  it('returns [] for a flat org', async () => {
    mockExpandOrgScope.mockResolvedValue(['ctx']);
    expect(await orgMembersService.listTeams('ctx')).toEqual({ teams: [] });
    expect(mockOrgFind).not.toHaveBeenCalled();
  });
});

describe('orgMembersService.bulkAddMemberToTeams', () => {
  it('adds the user to new teams and reports existing ones as already_member', async () => {
    mockExpandOrgScope.mockResolvedValue(['ctx', 'teamA', 'teamB']);
    mockUserFindById.mockReturnValue(sessionReturns({ _id: 'u1' }));
    mockUserOrgFindOne
      .mockReturnValueOnce(sessionReturns({ _id: 'existing' })) // teamA — already a member
      .mockReturnValueOnce(sessionReturns(null)); // teamB — not yet
    mockUserOrgCreate.mockResolvedValue([{ _id: 'new' }]);

    const { results } = await orgMembersService.bulkAddMemberToTeams('ctx', {
      userId: 'u1', orgIds: ['teamA', 'teamB'], role: 'member',
    });

    expect(results).toEqual([
      { orgId: 'teamA', status: 'already_member' },
      { orgId: 'teamB', status: 'added' },
    ]);
    expect(mockUserOrgCreate).toHaveBeenCalledTimes(1);
    expect(mockUserOrgCreate).toHaveBeenCalledWith(
      [{ userId: 'u1', organizationId: 'teamB', role: 'member' }],
      { session: { id: 'session' } },
    );
  });

  it('rejects when any target is outside the context org subtree', async () => {
    mockExpandOrgScope.mockResolvedValue(['ctx', 'teamA']);
    await expect(
      orgMembersService.bulkAddMemberToTeams('ctx', { userId: 'u1', orgIds: ['teamA', 'evil-org'] }),
    ).rejects.toThrow(OM_TARGETS_OUT_OF_SCOPE);
    // Short-circuits before resolving the user or writing anything.
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect(mockUserOrgCreate).not.toHaveBeenCalled();
  });

  it('throws USER_NOT_FOUND when the email/id resolves to no user', async () => {
    mockExpandOrgScope.mockResolvedValue(['ctx', 'teamA']);
    mockUserFindOne.mockReturnValue(sessionReturns(null));
    await expect(
      orgMembersService.bulkAddMemberToTeams('ctx', { email: 'nobody@example.com', orgIds: ['teamA'] }),
    ).rejects.toThrow(OM_USER_NOT_FOUND);
    expect(mockUserOrgCreate).not.toHaveBeenCalled();
  });
});
