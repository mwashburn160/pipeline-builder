// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the expired-invitation seat/pending leak.
 *
 * Invitations expire LAZILY (no TTL index / reaper flips them only periodically),
 * so a `status:'pending'` row can outlive its `expiresAt`. The pooled seat check
 * and the pooled-usage read must count only GENUINELY-LIVE invites — i.e. the
 * Invitation query must carry an `expiresAt: { $gt: now }` guard — otherwise an
 * org whose invites are never accepted stays pinned at its seat ceiling forever.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));

const mockResolveOrgLineage = jest.fn<(...a: unknown[]) => Promise<{ rootOrgId: string }>>();
const mockExpandOrgScope = jest.fn<(...a: unknown[]) => Promise<string[]>>();
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  resolveOrgLineage: mockResolveOrgLineage,
  expandOrgScope: mockExpandOrgScope,
}));

// Both seats.ts callers query distinct differently: seatCapacityAvailable
// chains `.session()`, pooledSeatUsage awaits the query directly. So each mock
// returns a thenable (resolves the array when awaited) that ALSO carries a
// `.session()` returning the same array.
const queryResolving = <T>(value: T) => {
  const p = Promise.resolve(value);
  return Object.assign(p, { session: () => p }) as unknown;
};

// Capture the filter each Invitation.distinct receives.
const invDistinctFilters: Array<Record<string, unknown>> = [];
const mockInvDistinct = jest.fn((_field: string, filter: Record<string, unknown>) => {
  invDistinctFilters.push(filter);
  // Emulate Mongo semantics: only return an email if the row genuinely matches
  // the filter. If the caller omitted the `expiresAt` guard, a stale (expired
  // but still `pending`) email would leak in — which is exactly the bug.
  const expiresGuard = filter.expiresAt as { $gt?: Date } | undefined;
  const matched = seededInvitations
    .filter(r => r.status === (filter.status as string))
    .filter(r => (expiresGuard?.$gt ? r.expiresAt > expiresGuard.$gt : true))
    .map(r => r.email);
  return queryResolving([...new Set(matched)]);
});

// UserOrganization.distinct → array of member ids.
const mockUoDistinct = jest.fn(() => queryResolving(seededMembers));

// Supports both chains used in seats.ts:
//   findById().select().session().lean()  (seatCapacityAvailable)
//   findById().select().lean()            (pooledSeatUsage)
const mockOrgFindById = jest.fn(() => {
  // pooledSeatUsage reads `quotas.seats`; pooledFeatureEntitlements reads
  // `featureEntitlements` off the same (root) doc — both are served here.
  const leaf = { lean: () => Promise.resolve({ quotas: { seats: seatLimit }, featureEntitlements: seededFeatures }) };
  const withSession = { session: () => leaf, lean: leaf.lean };
  return { select: () => withSession } as unknown;
});

jest.unstable_mockModule('../src/models/index.js', () => ({
  Invitation: { distinct: (...a: unknown[]) => mockInvDistinct(a[0] as string, a[1] as Record<string, unknown>) },
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  UserOrganization: { distinct: (...a: unknown[]) => mockUoDistinct(...a) },
}));

// Test-controlled fixtures the mocks read.
let seatLimit = 3;
let seededMembers: string[] = [];
let seededInvitations: Array<{ email: string; status: string; expiresAt: Date }> = [];
let seededFeatures: string[] | undefined = [];

const { seatCapacityAvailable, pooledSeatUsage, pooledFeatureEntitlements } = await import('../src/helpers/seats.js');

const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 60_000);

beforeEach(() => {
  jest.clearAllMocks();
  invDistinctFilters.length = 0;
  seatLimit = 3;
  seededMembers = [];
  seededInvitations = [];
  seededFeatures = [];
  mockResolveOrgLineage.mockResolvedValue({ rootOrgId: 'root-1' });
  mockExpandOrgScope.mockResolvedValue(['root-1']);
});

describe('seat capacity — expired invitations must not reserve a seat', () => {
  it('scopes the pending-invite query with an expiresAt > now guard', async () => {
    seededInvitations = [{ email: 'live@x.io', status: 'pending', expiresAt: future() }];
    await seatCapacityAvailable('org-1', 1);
    expect(invDistinctFilters).toHaveLength(1);
    const filter = invDistinctFilters[0];
    expect(filter.status).toBe('pending');
    expect(filter.expiresAt).toEqual({ $gt: expect.any(Date) });
  });

  it('does NOT count an expired-but-still-pending invite toward the cap', async () => {
    // limit 3, no members. One live pending + two expired-but-unswept pending.
    seatLimit = 3;
    seededInvitations = [
      { email: 'live@x.io', status: 'pending', expiresAt: future() },
      { email: 'stale1@x.io', status: 'pending', expiresAt: past() },
      { email: 'stale2@x.io', status: 'pending', expiresAt: past() },
    ];
    // used = 1 live invite → adding 2 must fit under the limit of 3 (would FAIL
    // at 3 used if the two stale rows were counted).
    expect(await seatCapacityAvailable('org-1', 2)).toBe(true);
  });

  it('still counts a genuinely-live pending invite toward the cap', async () => {
    seatLimit = 1;
    seededInvitations = [{ email: 'live@x.io', status: 'pending', expiresAt: future() }];
    // used = 1 (the live invite) → no room for one more.
    expect(await seatCapacityAvailable('org-1', 1)).toBe(false);
  });

  it('pooledSeatUsage excludes expired-but-pending invites from `used`', async () => {
    seatLimit = 10;
    seededMembers = ['m1'];
    seededInvitations = [
      { email: 'live@x.io', status: 'pending', expiresAt: future() },
      { email: 'stale@x.io', status: 'pending', expiresAt: past() },
    ];
    const { used, limit } = await pooledSeatUsage('org-1');
    expect(limit).toBe(10);
    // 1 member + 1 LIVE invite = 2 (the stale invite is not counted).
    expect(used).toBe(2);
    expect(invDistinctFilters[0].expiresAt).toEqual({ $gt: expect.any(Date) });
  });
});

describe('pooledFeatureEntitlements — the account (root) feature set', () => {
  it('resolves to root and returns the root org featureEntitlements', async () => {
    seededFeatures = ['sso', 'audit_log'];
    const features = await pooledFeatureEntitlements('org-1');
    expect(features).toEqual(['sso', 'audit_log']);
    // Pooled at the ROOT: the passed org id is resolved to its root first.
    expect(mockResolveOrgLineage).toHaveBeenCalledWith('org-1');
  });

  it('returns [] for an account with no purchased features (model default absent)', async () => {
    seededFeatures = undefined; // simulate a doc with no featureEntitlements field
    const features = await pooledFeatureEntitlements('org-1');
    expect(features).toEqual([]);
  });
});
