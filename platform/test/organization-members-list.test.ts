// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for OrgMembersService.listMembers — the paginated, filterable
 * roster read.
 *
 * The behavior under test: limit/offset bound the DB query (skip/limit, never
 * in-memory), the full filtered `total` is returned so the client can page,
 * each member carries its assigned Role names (so the UI needs no
 * O(members×roles) scan) + its `isActive` flag, and a search with no matching
 * user short-circuits to an empty page without a count query.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { seatsMock } from './helpers/seats-mock.js';

const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockUoFind = jest.fn<(...a: unknown[]) => unknown>();
const mockUoCount = jest.fn<(...a: unknown[]) => Promise<number>>();
const mockRaFind = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFind = jest.fn<(...a: unknown[]) => unknown>();
const mockUoAggregate = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});

jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ isAncestorOrg: async () => false, expandOrgScope: async (id: string) => [id] }));
jest.unstable_mockModule('../src/helpers/seats.js', () => seatsMock({
  seatCapacityAvailable: jest.fn(async () => true),
  seatCapacityStillWithinCap: jest.fn(async () => true),
  userHasSeatInAccount: jest.fn(async () => false),
}));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({ assertActorMayAssignBuiltinAdmin: async () => undefined, ensureBaselineRole: jest.fn(async () => undefined), assignBuiltinAdminRole: jest.fn(async () => true), recomputeUserOrgRole: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  User: { find: (...a: unknown[]) => mockUserFind(...a), collection: { name: 'users' } },
  UserOrganization: {
    find: (...a: unknown[]) => mockUoFind(...a),
    countDocuments: (...a: unknown[]) => mockUoCount(...a),
    aggregate: (...a: unknown[]) => mockUoAggregate(...a),
  },
  RoleAssignment: { find: (...a: unknown[]) => mockRaFind(...a) },
  // Linking stub: org-members-service revokes a leaving member's invitations.
  Invitation: {},
}));

// The member service's consent and Role-unassign guards (untested here).
jest.unstable_mockModule('../src/helpers/account-membership.js', () => ({ assertDirectAddConsented: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/services/role-crud.js', () => ({ assertActorMayStripMemberRoles: jest.fn(async () => ({ heldSuperadmin: false })), assertActorMayWieldMemberRoles: jest.fn(async () => []) }));

const { orgMembersService } = await import('../src/services/org-members-service.js');

// ─── Chainable-query mock builders ──────────────────────────────────────────

/** `Organization.findById(...).select(...).lean()` → org. */
const orgQuery = (org: unknown) => ({ select: () => ({ lean: () => Promise.resolve(org) }) });

/** `UserOrganization.aggregate(pipeline).option(opts)` → one `$facet` row,
 *  recording the pipeline and options so the stages can be asserted. */
let capturedPipeline: Array<Record<string, unknown>> = [];
let capturedAggOptions: unknown;
const aggQuery = (page: unknown[], total: number) => (pipeline: unknown) => {
  capturedPipeline = pipeline as Array<Record<string, unknown>>;
  return {
    option: (o: unknown) => {
      capturedAggOptions = o;
      return Promise.resolve([{ page, total: total > 0 ? [{ n: total }] : [] }]);
    },
  };
};
/** The stage object for operator `op` in the captured pipeline. */
const stage = (op: string) => capturedPipeline.find((s) => op in s)?.[op] as Record<string, unknown> | undefined;
const aggRows = [
  { user: { _id: 'u2', username: 'aaron', email: 'aaron@x.com', isEmailVerified: true }, role: 'member', isActive: true, joinedAt: new Date() },
  { user: { _id: 'u1', username: 'zed', email: 'zed@x.com', isEmailVerified: false }, role: 'admin', isActive: false },
];

/** `RoleAssignment.find(...).populate(...).lean()` → assignment rows. */
const raQuery = (rows: unknown[]) => ({ populate: () => ({ lean: () => Promise.resolve(rows) }) });

/** `UserOrganization.find(...).populate().sort().skip().limit().lean()` → rows,
 *  recording the skip/limit args so the pagination bound can be asserted. */
let capturedSkip: number | undefined;
let capturedLimit: number | undefined;
let capturedSort: unknown;
const uoQuery = (rows: unknown[]) => {
  const q: Record<string, (...a: unknown[]) => unknown> = {};
  q.populate = () => q;
  q.select = () => q;
  q.sort = (s: unknown) => { capturedSort = s; return q; };
  q.skip = (n: unknown) => { capturedSkip = n as number; return q; };
  q.limit = (n: unknown) => { capturedLimit = n as number; return q; };
  q.lean = () => Promise.resolve(rows);
  return q;
};

const org = { _id: 'org-1', name: 'Acme', owner: { toString: () => 'owner-1' } };
const memberships = [
  { userId: { _id: 'u1', username: 'alice', email: 'alice@x.com', isEmailVerified: true, createdAt: new Date(), updatedAt: new Date() }, role: 'admin', isActive: true, joinedAt: new Date() },
  { userId: { _id: 'u2', username: 'bob', email: 'bob@x.com', isEmailVerified: false, createdAt: new Date() }, role: 'member', isActive: false, joinedAt: new Date() },
];
const assignments = [
  { userId: 'u1', roleId: { _id: 'r1', name: 'Admin' } },
  { userId: 'u2', roleId: { _id: 'r2', name: 'Member' } },
];

beforeEach(() => {
  jest.clearAllMocks();
  capturedSkip = undefined;
  capturedLimit = undefined;
  capturedSort = undefined;
  mockOrgFindById.mockReturnValue(orgQuery(org));
  mockUoFind.mockReturnValue(uoQuery(memberships));
  mockUoCount.mockResolvedValue(42);
  mockRaFind.mockReturnValue(raQuery(assignments));
  capturedPipeline = [];
  capturedAggOptions = undefined;
  mockUoAggregate.mockImplementation(aggQuery(aggRows, 2));
});

describe('OrgMembersService.listMembers', () => {
  it('bounds the query with offset/limit and returns the full total', async () => {
    const result = await orgMembersService.listMembers('org-1', { offset: 5, limit: 10 });

    // limit/offset are pushed into the DB find (skip/limit), not applied in memory.
    expect(capturedSkip).toBe(5);
    expect(capturedLimit).toBe(10);

    expect(result).not.toBeNull();
    expect(result!.total).toBe(42); // full filtered count, not the page length
    expect(result!.offset).toBe(5);
    expect(result!.limit).toBe(10);
    expect(result!.members).toHaveLength(2);
  });

  it('clamps an oversized limit to the hard cap', async () => {
    await orgMembersService.listMembers('org-1', { limit: 9999 });
    expect(capturedLimit).toBe(200);
  });

  it('annotates each member with its Role names + active flag', async () => {
    const result = await orgMembersService.listMembers('org-1', {});
    const [alice, bob] = result!.members;

    expect(alice.roles).toEqual([{ id: 'r1', name: 'Admin' }]);
    expect(alice.isActive).toBe(true);
    expect(bob.roles).toEqual([{ id: 'r2', name: 'Member' }]);
    expect(bob.isActive).toBe(false);
  });

  it('answers an empty page when a search matches no member', async () => {
    mockUoAggregate.mockImplementation(aggQuery([], 0));
    const result = await orgMembersService.listMembers('org-1', { search: 'nobody', limit: 25 });

    expect(result!.members).toEqual([]);
    expect(result!.total).toBe(0);
    expect(result!.limit).toBe(25);
    expect(mockRaFind).not.toHaveBeenCalled();
  });

  it('searches FROM the org\'s memberships, never the whole users collection', async () => {
    const result = await orgMembersService.listMembers('org-1', { search: '  ali  ', role: 'admin', isActive: true, offset: 3, limit: 7 });

    // No unscoped User scan, no membership find/count.
    expect(mockUserFind).not.toHaveBeenCalled();
    expect(mockUoFind).not.toHaveBeenCalled();
    expect(mockUoCount).not.toHaveBeenCalled();
    // The first stage pins the org (plus role/status filters).
    expect(capturedPipeline[0]).toEqual({ $match: { organizationId: 'org-1', role: 'admin', isActive: true } });
    // The search runs inside the per-membership user join, on username/email.
    const lookup = stage('$lookup')!;
    expect(lookup).toMatchObject({ from: 'users', localField: 'userId', foreignField: '_id', as: 'user' });
    const userMatch = (lookup.pipeline as Array<Record<string, unknown>>)[0].$match as { $or: Array<Record<string, RegExp>> };
    expect(userMatch.$or[0].username.source).toBe('ali');
    expect(userMatch.$or[0].username.flags).toBe('i');
    expect(userMatch.$or[1].email.source).toBe('ali');
    // Paged in the database, with the total from the same pass.
    expect(stage('$facet')).toEqual({ page: [{ $skip: 3 }, { $limit: 7 }], total: [{ $count: 'n' }] });
    expect(capturedAggOptions).toEqual({ maxTimeMS: expect.any(Number) });
    expect(result!.total).toBe(2);
    expect(result!.members.map((m) => m.id)).toEqual(['u2', 'u1']);
    // Response shape unchanged.
    expect(result!.members[1]).toEqual({
      id: 'u1',
      username: 'zed',
      email: 'zed@x.com',
      role: 'admin',
      isEmailVerified: false,
      isActive: false,
      isOwner: false,
      joinedAt: undefined,
      createdAt: undefined,
      updatedAt: undefined,
      roles: [{ id: 'r1', name: 'Admin' }],
    });
  });

  it('escapes regex metacharacters and caps the search length', async () => {
    await orgMembersService.listMembers('org-1', { search: `a.*(b${'x'.repeat(500)}` });
    const lookup = stage('$lookup')!;
    const rx = ((lookup.pipeline as Array<Record<string, unknown>>)[0].$match as { $or: Array<Record<string, RegExp>> }).$or[0].username;
    expect(rx.source.startsWith('a\\.\\*\\(b')).toBe(true);
    expect(rx.test(`A.*(B${'X'.repeat(96)}`)).toBe(true);
    expect(rx.test(`aZZb${'x'.repeat(96)}`)).toBe(false);
    // 100 characters of input survive, escaped.
    expect(rx.source.replace(/\\/g, '').length).toBe(100);
  });

  it('sorts a search by a native membership field inside the aggregation', async () => {
    await orgMembersService.listMembers('org-1', { search: 'a', sortBy: 'role', sortOrder: 'desc' });
    expect(stage('$sort')).toEqual({ role: -1, _id: 1 });
  });

  it('sorts a search by the default join-time order when no sort is given', async () => {
    await orgMembersService.listMembers('org-1', { search: 'a' });
    expect(stage('$sort')).toEqual({ joinedAt: 1, _id: 1 });
  });

  it('returns null when the org does not exist', async () => {
    mockOrgFindById.mockReturnValue(orgQuery(null));
    expect(await orgMembersService.listMembers('ghost', {})).toBeNull();
  });

  it('pushes the status (isActive) filter into the DB query', async () => {
    await orgMembersService.listMembers('org-1', { isActive: false });
    const filterArg = mockUoFind.mock.calls[0][0] as Record<string, unknown>;
    expect(filterArg).toMatchObject({ isActive: false });

    // An omitted status leaves the flag off the filter entirely (both states).
    jest.clearAllMocks();
    mockUoFind.mockReturnValue(uoQuery(memberships));
    mockUoCount.mockResolvedValue(42);
    mockRaFind.mockReturnValue(raQuery(assignments));
    await orgMembersService.listMembers('org-1', {});
    expect(mockUoFind.mock.calls[0][0]).not.toHaveProperty('isActive');
  });

  it('applies a whitelisted sort field to the query', async () => {
    await orgMembersService.listMembers('org-1', { sortBy: 'role', sortOrder: 'desc' });
    // Native (UserOrganization) field → sorts the membership query directly,
    // descending, with a stable _id tiebreak.
    expect(capturedSort).toEqual({ role: -1, _id: 1 });
  });

  it('rejects an unknown sort field, falling back to the default join-time order', async () => {
    await orgMembersService.listMembers('org-1', { sortBy: 'password', sortOrder: 'asc' });
    expect(capturedSort).toEqual({ joinedAt: 1, _id: 1 });
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'treats inherited Object.prototype name %p as unknown (default order, not a sort on `undefined`)',
    async (sortBy) => {
      await orgMembersService.listMembers('org-1', { sortBy, sortOrder: 'desc' });
      expect(capturedSort).toEqual({ joinedAt: 1, _id: 1 });
    },
  );

  it('sorts by a joined User field (username) in one org-scoped aggregation', async () => {
    const result = await orgMembersService.listMembers('org-1', { sortBy: 'username', sortOrder: 'asc' });

    // No full-membership load + unbounded $in: the order is applied in the DB.
    expect(mockUoFind).not.toHaveBeenCalled();
    expect(mockUserFind).not.toHaveBeenCalled();
    expect(capturedPipeline[0]).toEqual({ $match: { organizationId: 'org-1' } });
    // No search → the join carries only the projection.
    expect((stage('$lookup')!.pipeline as unknown[])).toHaveLength(1);
    expect(stage('$sort')).toEqual({ 'user.username': 1, '_id': 1 });
    expect(result!.total).toBe(2);
    // The page preserves the database order (aaron before zed).
    expect(result!.members.map((m) => m.id)).toEqual(['u2', 'u1']);
  });

  it('answers total 0 when the aggregation returns no facet row', async () => {
    mockUoAggregate.mockImplementation(() => ({ option: () => Promise.resolve([]) }));
    const result = await orgMembersService.listMembers('org-1', { sortBy: 'email', sortOrder: 'desc' });
    expect(result!.total).toBe(0);
    expect(result!.members).toEqual([]);
  });
});
