// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /internal/offers/seat-activity/:orgId` (controllers/offers-internal.ts):
 * seats held, members active in the window, and members who JOINED in the
 * window without being active in it — so a just-added member (no `lastActiveAt`
 * yet) is not read as a disengaging seat. Inactive = held − active − new.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { PLATFORM_INTERNAL } from '@pipeline-builder/api-core';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const SCOPE = [ORG, 'team-1'];
const mockCount = jest.fn<(filter: Record<string, any>) => Promise<number>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, data }),
}));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ expandOrgScope: async () => SCOPE }));
jest.unstable_mockModule('../src/models/user-organization.js', () => ({
  default: { countDocuments: (f: Record<string, any>) => mockCount(f) },
}));

const { getOrgSeatActivity } = await import('../src/controllers/offers-internal.js');

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn((b: unknown) => { res.body = b; return res; });
  return res;
}

/** Answer each of the three counts by which filter it is. */
function counts(held: number, active: number, fresh: number): void {
  mockCount.mockImplementation(async (f) => {
    if (f.createdAt) return fresh;
    if (f.lastActiveAt) return active;
    return held;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  counts(10, 6, 3);
});

describe('GET /internal/offers/seat-activity/:orgId', () => {
  it('reports held, active and new members, validating through the contract', async () => {
    const res = mockRes();
    await getOrgSeatActivity({ params: { orgId: ORG }, query: { windowDays: '30' } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({
      seatActivity: { orgId: ORG, windowDays: 30, seatsHeld: 10, activeMembers: 6, newMembers: 3 },
    });
    expect(() => PLATFORM_INTERNAL.offerSeatActivity.response!.parse(res.body.data)).not.toThrow();
  });

  it('counts a new member as JOINED inside the window and NOT active in it (missing lastActiveAt included)', async () => {
    const before = Date.now();
    await getOrgSeatActivity({ params: { orgId: ORG }, query: { windowDays: '7' } } as any, mockRes());
    const filters = mockCount.mock.calls.map(([f]) => f);
    const fresh = filters.find((f) => f.createdAt)!;
    const active = filters.find((f) => f.lastActiveAt && !f.createdAt)!;

    expect(fresh.organizationId).toEqual({ $in: SCOPE });
    expect(fresh.isActive).toBe(true);
    const since = fresh.createdAt.$gte as Date;
    expect(Math.abs(before - 7 * 86_400_000 - since.getTime())).toBeLessThan(5_000);
    // `$not: { $gte }` matches a missing / null `lastActiveAt` as well as an old
    // one — exactly the complement of the active filter, so the counts are disjoint.
    expect(fresh.lastActiveAt).toEqual({ $not: { $gte: since } });
    expect(active.lastActiveAt).toEqual({ $gte: since });
  });

  it('requires newMembers in the contract', () => {
    expect(() => PLATFORM_INTERNAL.offerSeatActivity.response!.parse({
      seatActivity: { orgId: ORG, windowDays: 30, seatsHeld: 1, activeMembers: 1 },
    })).toThrow();
  });
});
