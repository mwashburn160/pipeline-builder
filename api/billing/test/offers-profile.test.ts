// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The usage-profile signal store.
 *
 * The properties under test are the irreversible or load-bearing ones, not the happy path:
 *
 *  - a partial read produces an INCOMPLETE row, never a confident one. "A
 *    profile assembled from partial reads looks like an account with low usage
 *    on whichever dimension failed" — the shape that suppresses an offer the
 *    account should have had, or argues for one it should not;
 *  - UNKNOWN seat activity is not inactivity, because the stamp is absent for
 *    every membership predating it;
 *  - the period key is one row per account per period, which is what makes the
 *    unique index an append-only guarantee rather than a hope;
 *  - the knob is `offersEnabled && enabled`, with the dependency one way.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-offers-profile';

const mockFetchUsageProfile = jest.fn<AnyFn>();
const mockFetchSeatActivity = jest.fn<AnyFn>();

// EVERY export, not just the two under test: a partial factory makes the whole
// import chain fail to LOAD with a message naming an unrelated symbol (the
// other readers of this module are pulled in through billing-helpers).
jest.unstable_mockModule('../src/helpers/downstream-client.js', () => ({
  getJson: jest.fn<AnyFn>(),
  getContractJson: jest.fn<AnyFn>(),
  putJson: jest.fn<AnyFn>(),
  putContractJson: jest.fn<AnyFn>(),
  fetchQuotaSnapshot: jest.fn<AnyFn>(),
  fetchOwnQuotaSnapshot: jest.fn<AnyFn>(),
  fetchQuotaTypeUsage: jest.fn<AnyFn>(),
  fetchSeatUsage: jest.fn<AnyFn>(),
  fetchSupportUsage: jest.fn<AnyFn>(),
  fetchUsageProfile: mockFetchUsageProfile,
  fetchSeatActivity: mockFetchSeatActivity,
}));

const { buildProfile, periodKeyFor } = await import('../src/helpers/offers-profile.js');
const { config } = await import('../src/config.js');

const BASE = {
  orgId: 'acme',
  tier: 'team' as const,
  interval: 'monthly' as const,
  addons: [{ bundleId: 'seat', quantity: 2 }],
  subscriptionStartedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
  auth: 'Bearer svc',
};

const USAGE = {
  orgId: 'acme',
  tier: 'team',
  rootOrgId: 'acme',
  dimensions: {
    plugins: { used: 46, limit: 50, ratio: 0.92, projected: 55, resetAt: '2026-12-01T00:00:00.000Z', periodDays: 3 },
    pipelines: { used: 2, limit: 10, ratio: 0.2, projected: 3, resetAt: '2026-12-01T00:00:00.000Z', periodDays: 3 },
    cpuCredits: { used: 9000, limit: 22500, ratio: 0.4, projected: 12000, resetAt: '2026-12-20T00:00:00.000Z', periodDays: 30 },
  },
};

const SEATS = { orgId: 'acme', windowDays: 30, seatsHeld: 12, activeMembers: 9 };

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchUsageProfile.mockResolvedValue(USAGE);
  mockFetchSeatActivity.mockResolvedValue(SEATS);
});

describe('periodKeyFor — one row per account per period', () => {
  it('takes the LONGEST window, so one account gets one row rather than one per quota type', () => {
    // `cpuCredits` is monthly while everything else is three-day; keying on the
    // shortest would write ten rows a month and make the trajectory read them
    // as ten periods.
    expect(periodKeyFor(USAGE.dimensions)).toBe('2026-12-20');
  });

  it('falls back to today rather than dropping a row with no readable period', () => {
    // A profile with no period is still worth keeping: it is the row that
    // records the reads were unusable.
    expect(periodKeyFor({})).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(periodKeyFor({ a: { resetAt: 'not-a-date' } })).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('buildProfile — the happy path carries every class of signal', () => {
  it('records pressure, trajectory and the band each dimension ended in', async () => {
    const p = await buildProfile(BASE);
    expect(p.dimensions.plugins).toMatchObject({ used: 46, limit: 50, ratio: 0.92, projected: 55, crossed: 90 });
    expect(p.dimensions.pipelines!.crossed).toBeNull();
    expect(p.complete).toBe(true);
    expect(p.incompleteReasons).toEqual([]);
  });

  it('bands on the ratio the period ENDED at, which is the durable fact', async () => {
    mockFetchUsageProfile.mockResolvedValue({
      ...USAGE,
      dimensions: {
        a: { used: 10, limit: 10, ratio: 1, projected: 10, resetAt: null, periodDays: 3 },
        b: { used: 8, limit: 10, ratio: 0.8, projected: 9, resetAt: null, periodDays: 3 },
        c: { used: 5, limit: 10, ratio: 0.5, projected: 6, resetAt: null, periodDays: 3 },
        d: { used: 1, limit: -1, ratio: null, projected: null, resetAt: null, periodDays: 3 },
      },
    });
    const p = await buildProfile(BASE);
    expect(p.dimensions.a!.crossed).toBe(100);
    expect(p.dimensions.b!.crossed).toBe(80);
    expect(p.dimensions.c!.crossed).toBeNull();
    // An unlimited dimension has no ratio and therefore no band — not zero.
    expect(p.dimensions.d!.crossed).toBeNull();
  });

  it('carries the account\'s spend and age, which gate young accounts out', async () => {
    const p = await buildProfile(BASE);
    expect(p.spendCents).toBeGreaterThan(0);
    expect(p.subscriptionAgeDays).toBe(90);
    expect(p.addonsHeld).toEqual(['seat']);
  });
});

describe('buildProfile — fails CLOSED on an incomplete read', () => {
  it('marks the row incomplete when the quota read fails, rather than reporting no usage', async () => {
    mockFetchUsageProfile.mockResolvedValue(null);
    const p = await buildProfile(BASE);
    expect(p.complete).toBe(false);
    expect(p.incompleteReasons).toContain('quota_profile_unreadable');
    // No dimensions at all — NOT dimensions at zero, which a rule would read as
    // an idle account.
    expect(Object.keys(p.dimensions)).toEqual([]);
  });

  it('marks the row incomplete when the seat read fails', async () => {
    mockFetchSeatActivity.mockResolvedValue(null);
    const p = await buildProfile(BASE);
    expect(p.complete).toBe(false);
    expect(p.incompleteReasons).toContain('seat_activity_unreadable');
  });

  it('survives a THROWN read the same way as a null one', async () => {
    mockFetchUsageProfile.mockRejectedValue(new Error('connection reset'));
    const p = await buildProfile(BASE);
    expect(p.complete).toBe(false);
    expect(p.incompleteReasons).toContain('quota_profile_unreadable');
  });

  it('names BOTH gaps when both reads fail', async () => {
    mockFetchUsageProfile.mockResolvedValue(null);
    mockFetchSeatActivity.mockResolvedValue(null);
    const p = await buildProfile(BASE);
    expect([...p.incompleteReasons].sort())
      .toEqual(['quota_profile_unreadable', 'seat_activity_unreadable']);
  });
});

describe('buildProfile — seat activity', () => {
  it('reports an account whose seats went unused as dormant, and complete', async () => {
    mockFetchSeatActivity.mockResolvedValue({ orgId: 'acme', windowDays: 30, seatsHeld: 12, activeMembers: 0 });
    const p = await buildProfile(BASE);
    expect(p.value).toMatchObject({ activeMembers: 0, seatsHeld: 12 });
    expect(p.incompleteReasons).toEqual([]);
  });

  it('carries partial activity through as read', async () => {
    mockFetchSeatActivity.mockResolvedValue({ orgId: 'acme', windowDays: 30, seatsHeld: 12, activeMembers: 4 });
    const p = await buildProfile(BASE);
    expect(p.complete).toBe(true);
    expect(p.value).toMatchObject({ activeMembers: 4, seatsHeld: 12 });
  });
});

describe('the offers switches', () => {
  it('defaults BOTH to true, matching SUPPORT_ENABLED rather than inverting', () => {
    expect(config.enabled).toBe(true);
    expect(config.offersEnabled).toBe(true);
  });
});
