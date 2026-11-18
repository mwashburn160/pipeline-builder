// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /internal/offers/seat-activity/:orgId` (controllers/offers-internal.ts):
 * seats held (distinct PEOPLE — the per-person semantics run against real Mongo
 * in offers-seat-activity.integration.test.ts), people active in the window, and people who JOINED in the
 * window without being active in it — so a just-added member (no `lastActiveAt`
 * yet) is not read as a disengaging seat. Inactive = held − active − new.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { PLATFORM_INTERNAL } from '@pipeline-builder/api-core';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const SCOPE = [ORG, 'team-1'];
const mockAggregate = jest.fn<(pipeline: Array<Record<string, any>>) => Promise<unknown[]>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, data }),
}));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ expandOrgScope: async () => SCOPE }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: string) => v }));
jest.unstable_mockModule('../src/models/user-organization.js', () => ({
  default: { aggregate: (p: Array<Record<string, any>>) => mockAggregate(p) },
}));

const { getOrgSeatActivity } = await import('../src/controllers/offers-internal.js');

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn((b: unknown) => { res.body = b; return res; });
  return res;
}

/** Answer the one per-person aggregation with these three counts. */
function counts(held: number, active: number, fresh: number): void {
  mockAggregate.mockResolvedValue([{ _id: null, seatsHeld: held, activeMembers: active, newMembers: fresh }]);
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

  it('groups by PERSON across the subtree, then counts new = joined in the window and not active in it', async () => {
    const before = Date.now();
    await getOrgSeatActivity({ params: { orgId: ORG }, query: { windowDays: '7' } } as any, mockRes());
    const [pipeline] = mockAggregate.mock.calls[0];

    expect(pipeline[0]).toEqual({ $match: { organizationId: { $in: SCOPE }, isActive: true } });
    // One row per user: their latest activity, their earliest join.
    expect(pipeline[1].$group).toEqual({ _id: '$userId', lastActiveAt: { $max: '$lastActiveAt' }, joinedAt: { $min: '$createdAt' } });
    const totals = pipeline[2].$group;
    const since = totals.activeMembers.$sum.$cond[0].$gte[1] as Date;
    expect(Math.abs(before - 7 * 86_400_000 - since.getTime())).toBeLessThan(5_000);
    // `new` is exactly "not active" AND joined since — disjoint from active.
    expect(totals.newMembers.$sum.$cond[0]).toEqual({ $and: [{ $not: [{ $gte: ['$lastActiveAt', since] }] }, { $gte: ['$joinedAt', since] }] });
  });

  it('reports zeros for an account with no active members (the aggregation yields no row)', async () => {
    mockAggregate.mockResolvedValue([]);
    const res = mockRes();
    await getOrgSeatActivity({ params: { orgId: ORG }, query: {} } as any, res);
    expect(res.body.data.seatActivity).toMatchObject({ seatsHeld: 0, activeMembers: 0, newMembers: 0 });
  });

  it('requires newMembers in the contract', () => {
    expect(() => PLATFORM_INTERNAL.offerSeatActivity.response!.parse({
      seatActivity: { orgId: ORG, windowDays: 30, seatsHeld: 1, activeMembers: 1 },
    })).toThrow();
  });
});
