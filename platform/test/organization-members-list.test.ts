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

const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockUoFind = jest.fn<(...a: unknown[]) => unknown>();
const mockUoCount = jest.fn<(...a: unknown[]) => Promise<number>>();
const mockRaFind = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFind = jest.fn<(...a: unknown[]) => unknown>();

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
}));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({ ensureBaselineRole: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));
// Identity escape keeps the search-regex assertions simple.
jest.unstable_mockModule('../src/utils/regex.js', () => ({ escapeRegex: (s: string) => s }));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  User: { find: (...a: unknown[]) => mockUserFind(...a) },
  UserOrganization: {
    find: (...a: unknown[]) => mockUoFind(...a),
    countDocuments: (...a: unknown[]) => mockUoCount(...a),
  },
  RoleAssignment: { find: (...a: unknown[]) => mockRaFind(...a) },
}));

const { orgMembersService } = await import('../src/services/org-members-service.js');

// ─── Chainable-query mock builders ──────────────────────────────────────────

/** `Organization.findById(...).select(...).lean()` → org. */
const orgQuery = (org: unknown) => ({ select: () => ({ lean: () => Promise.resolve(org) }) });

/** `User.find(...).select(...).lean()` → rows (search-id prefilter). */
const userQuery = (rows: unknown[]) => ({ select: () => ({ lean: () => Promise.resolve(rows) }) });

/** `RoleAssignment.find(...).populate(...).lean()` → assignment rows. */
const raQuery = (rows: unknown[]) => ({ populate: () => ({ lean: () => Promise.resolve(rows) }) });

/** `UserOrganization.find(...).populate().sort().skip().limit().lean()` → rows,
 *  recording the skip/limit args so the pagination bound can be asserted. */
let capturedSkip: number | undefined;
let capturedLimit: number | undefined;
const uoQuery = (rows: unknown[]) => {
  const q: Record<string, (...a: unknown[]) => unknown> = {};
  q.populate = () => q;
  q.sort = () => q;
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
  mockOrgFindById.mockReturnValue(orgQuery(org));
  mockUoFind.mockReturnValue(uoQuery(memberships));
  mockUoCount.mockResolvedValue(42);
  mockRaFind.mockReturnValue(raQuery(assignments));
  mockUserFind.mockReturnValue(userQuery([{ _id: 'u1' }]));
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

  it('short-circuits to an empty page (no count query) when a search matches no user', async () => {
    mockUserFind.mockReturnValue(userQuery([]));
    const result = await orgMembersService.listMembers('org-1', { search: 'nobody', limit: 25 });

    expect(result!.members).toEqual([]);
    expect(result!.total).toBe(0);
    expect(result!.limit).toBe(25);
    expect(mockUoCount).not.toHaveBeenCalled();
    expect(mockUoFind).not.toHaveBeenCalled();
  });

  it('returns null when the org does not exist', async () => {
    mockOrgFindById.mockReturnValue(orgQuery(null));
    expect(await orgMembersService.listMembers('ghost', {})).toBeNull();
  });
});
