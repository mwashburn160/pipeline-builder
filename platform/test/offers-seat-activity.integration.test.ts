// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for `GET /internal/offers/seat-activity/:orgId`
 * (controllers/offers-internal.ts): seats are PEOPLE, not membership rows.
 *
 * Seats pool at the account root and a person who belongs to the root AND one
 * of its teams holds ONE seat (the same rule `helpers/seats.ts` counts by) —
 * counting rows reported them twice, inflating `seatsHeld` and, through it, the
 * pressure the offer engine reads. Each count is per distinct user, decided on
 * that person's memberships across the subtree taken together.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default).
 */

import { jest, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('offers seat activity (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, getOrgSeatActivity: any, PLATFORM_INTERNAL: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    ({ getOrgSeatActivity } = await import('../src/controllers/offers-internal.js'));
    ({ PLATFORM_INTERNAL } = await import('@pipeline-builder/api-core'));
  }, 120_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  let rootId: string;
  let teamId: string;
  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Organization]) await model.deleteMany({});
    const root = await m.Organization.create({ name: 'Acme', owner: new mongoose.Types.ObjectId(), tier: 'team' });
    const team = await m.Organization.create({ name: 'Acme Eng', owner: root.owner, tier: 'team', parentOrgId: root._id });
    rootId = String(root._id);
    teamId = String(team._id);
  });

  const DAY = 86_400_000;
  const longAgo = new Date(Date.now() - 200 * DAY);

  /** A membership row; `createdAt` is set explicitly (timestamps would stamp now). */
  async function member(userId: unknown, orgId: string, opts: { createdAt?: Date; lastActiveAt?: Date; isActive?: boolean } = {}) {
    const doc = await m.UserOrganization.create({ userId, organizationId: orgId, role: 'member', isActive: opts.isActive ?? true });
    await m.UserOrganization.collection.updateOne(
      { _id: doc._id },
      { $set: { createdAt: opts.createdAt ?? longAgo, ...(opts.lastActiveAt ? { lastActiveAt: opts.lastActiveAt } : {}) } },
    );
  }

  async function read(windowDays = 30) {
    const res: any = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn((b: unknown) => { res.body = b; return res; });
    await getOrgSeatActivity({ params: { orgId: rootId }, query: { windowDays: String(windowDays) } }, res);
    return res.body.data;
  }

  it('counts a person with memberships in the root AND a team as ONE seat, not two', async () => {
    const both = new mongoose.Types.ObjectId();
    const rootOnly = new mongoose.Types.ObjectId();
    // Active in the window through the TEAM only — still one active person.
    await member(both, rootId, { createdAt: longAgo });
    await member(both, teamId, { createdAt: longAgo, lastActiveAt: new Date() });
    await member(rootOnly, rootId, { createdAt: longAgo });

    const data = await read();
    expect(data.seatActivity).toMatchObject({ orgId: rootId, seatsHeld: 2, activeMembers: 1, newMembers: 0 });
    expect(() => PLATFORM_INTERNAL.offerSeatActivity.response.parse(data)).not.toThrow();
  });

  it('counts a person as NEW only when they joined the account inside the window and were not active anywhere in it', async () => {
    const recentJoiner = new mongoose.Types.ObjectId();
    const veteranAddedToTeam = new mongoose.Types.ObjectId();
    // Joined last week, never signed in: new — even with two rows.
    await member(recentJoiner, rootId, { createdAt: new Date(Date.now() - 7 * DAY) });
    await member(recentJoiner, teamId, { createdAt: new Date(Date.now() - 6 * DAY) });
    // Held a seat for months, merely added to a team this week: NOT new — an
    // inactive seat, which is exactly the disengagement signal.
    await member(veteranAddedToTeam, rootId, { createdAt: longAgo });
    await member(veteranAddedToTeam, teamId, { createdAt: new Date(Date.now() - 2 * DAY) });

    const { seatActivity } = await read();
    expect(seatActivity).toMatchObject({ seatsHeld: 2, activeMembers: 0, newMembers: 1 });
  });

  it('ignores deactivated memberships', async () => {
    const gone = new mongoose.Types.ObjectId();
    await member(gone, rootId, { isActive: false, lastActiveAt: new Date() });
    expect((await read()).seatActivity).toMatchObject({ seatsHeld: 0, activeMembers: 0, newMembers: 0 });
  });
});
