// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for the member roster's joined read (search and
 * username/email sort): the aggregation starts from ONE org's memberships, so
 * a user outside the org never matches however well their name fits, the
 * search is a literal (escaped) substring, deleted users drop out of both the
 * page and the total, and the page/total match the filtered set.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped by default).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('Org member roster search + user-field sort (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, svc: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  let orgId: string;

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    ({ orgMembersService: svc } = await import('../src/services/org-members-service.js'));
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      m.Organization.collection.deleteMany({}),
      m.User.collection.deleteMany({}),
      m.UserOrganization.collection.deleteMany({}),
      m.RoleAssignment.collection.deleteMany({}),
    ]);
    const oid = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    orgId = oid.toString();
    await m.Organization.collection.insertMany([
      { _id: oid, name: 'Acme', slug: 'acme', owner: null },
      { _id: other, name: 'Other', slug: 'other', owner: null },
    ]);
    const user = (username: string) => ({
      _id: new mongoose.Types.ObjectId(), username, email: `${username}@x.com`, isEmailVerified: true,
    });
    const [carol, alice, bob, dotty, outsider, ghost] = [
      user('carol'), user('alice'), user('bob'), user('a.b'), user('alice2'), user('alighost'),
    ];
    await m.User.collection.insertMany([carol, alice, bob, dotty, outsider]); // ghost is never inserted
    const t = (n: number) => new Date(Date.UTC(2026, 0, n));
    await m.UserOrganization.collection.insertMany([
      { userId: carol._id, organizationId: oid, role: 'owner', isActive: true, joinedAt: t(1) },
      { userId: alice._id, organizationId: oid, role: 'admin', isActive: true, joinedAt: t(2) },
      { userId: bob._id, organizationId: oid, role: 'member', isActive: false, joinedAt: t(3) },
      { userId: dotty._id, organizationId: oid, role: 'member', isActive: true, joinedAt: t(4) },
      { userId: ghost._id, organizationId: oid, role: 'member', isActive: true, joinedAt: t(5) },
      { userId: outsider._id, organizationId: other, role: 'member', isActive: true, joinedAt: t(1) },
    ]);
  });

  it('matches only this org\'s members, case-insensitively', async () => {
    const page = await svc.listMembers(orgId, { search: 'ALI' });
    expect(page.members.map((x: { username: string }) => x.username)).toEqual(['alice']);
    expect(page.total).toBe(1);
    expect(page.members[0]).toMatchObject({ email: 'alice@x.com', role: 'admin', isActive: true, isOwner: false, roles: [] });
  });

  it('treats regex metacharacters literally', async () => {
    const page = await svc.listMembers(orgId, { search: 'a.b' });
    expect(page.members.map((x: { username: string }) => x.username)).toEqual(['a.b']);
    expect((await svc.listMembers(orgId, { search: '.*' })).total).toBe(0);
  });

  it('combines search with the role/status filters', async () => {
    const page = await svc.listMembers(orgId, { search: '@x.com', isActive: true, role: 'member' });
    expect(page.members.map((x: { username: string }) => x.username)).toEqual(['a.b']);
  });

  it('sorts by username and pages, dropping deleted users from page and total', async () => {
    const first = await svc.listMembers(orgId, { sortBy: 'username', sortOrder: 'asc', limit: 2, offset: 0 });
    const second = await svc.listMembers(orgId, { sortBy: 'username', sortOrder: 'asc', limit: 2, offset: 2 });
    expect(first.total).toBe(4);
    expect(first.members.map((x: { username: string }) => x.username)).toEqual(['a.b', 'alice']);
    expect(second.members.map((x: { username: string }) => x.username)).toEqual(['bob', 'carol']);

    const desc = await svc.listMembers(orgId, { sortBy: 'email', sortOrder: 'desc' });
    expect(desc.members.map((x: { username: string }) => x.username)).toEqual(['carol', 'bob', 'alice', 'a.b']);
  });

  it('orders a search by join time by default', async () => {
    const page = await svc.listMembers(orgId, { search: 'x.com' });
    expect(page.members.map((x: { username: string }) => x.username)).toEqual(['carol', 'alice', 'bob', 'a.b']);
    expect(page.members[0].isOwner).toBe(true);
  });
});
