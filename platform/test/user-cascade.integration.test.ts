// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo (replica set — the cascade is transactional) test for the shared
 * user-delete cascade and the last-privileged-member guard:
 *   - self-serve and admin deletion remove the user's domain-join requests, so an
 *     admin can't later approve one into an orphan membership that holds a seat;
 *   - approving a request whose requester was deleted is refused;
 *   - the owner and last-privileged-member guards hold for both delete paths and
 *     for removing a user from a Role.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default) — mirrors
 * organization-id-storage.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('user delete cascade (real Mongo replica set)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mongoose: any, m: any, userProfileService: any, userAdminService: any, orgDomainService: any, rolesService: any;

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    // Collections must exist before a transaction writes to them.
    for (const model of [m.User, m.UserOrganization, m.Role, m.RoleAssignment, m.JoinRequest, m.PersonalAccessToken, m.UserPreferences, m.Organization, m.WebAuthnCredential]) {
      await model.createCollection().catch(() => undefined);
    }
    ({ userProfileService } = await import('../src/services/user-profile-service.js'));
    ({ userAdminService } = await import('../src/services/user-admin-service.js'));
    ({ orgDomainService } = await import('../src/services/org-domain-service.js'));
    rolesService = {
      ...(await import('../src/services/roles-service.js')),
      ...(await import('../src/services/role-crud.js')),
    };
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  let orgId: string;
  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Role, m.RoleAssignment, m.JoinRequest, m.Organization, m.WebAuthnCredential]) await model.deleteMany({});
    const org = await m.Organization.create({ name: 'Acme', owner: new mongoose.Types.ObjectId() });
    orgId = String(org._id);
  });

  const newUser = (name: string) => m.User.create({ username: name, email: `${name}@acme.com`, isEmailVerified: true });
  const privilegedRole = () => m.Role.create({ organizationId: orgId, name: 'Admin', grantsRole: 'admin', permissions: [] });

  it.each([
    ['self-serve deleteAccount', (id: string) => userProfileService.deleteAccount(id)],
    ['admin deleteUserById', (id: string) => userAdminService.deleteUserById(id)],
  ])('%s removes the user\'s join requests and passkeys with the account', async (_name, del) => {
    const u = await newUser('leaver');
    await m.JoinRequest.create({ orgId, userId: u._id, email: u.email });
    await m.UserOrganization.create({ userId: u._id, organizationId: orgId, role: 'member' });
    await m.WebAuthnCredential.create({
      userId: u._id, credentialId: 'cred-leaver', publicKey: Buffer.from([1, 2, 3]), counter: 0, name: 'Laptop',
    });

    await del(String(u._id));

    expect(await m.User.exists({ _id: u._id })).toBeNull();
    expect(await m.JoinRequest.countDocuments({ userId: u._id })).toBe(0);
    expect(await m.UserOrganization.countDocuments({ userId: u._id })).toBe(0);
    // A leftover credential would keep its unique `credentialId` reserved, so
    // re-enrolling the same authenticator later would fail on the unique index.
    expect(await m.WebAuthnCredential.countDocuments({ userId: u._id })).toBe(0);
  });

  it('refuses to approve a join request whose requester no longer exists — no orphan membership', async () => {
    const u = await newUser('ghost');
    const request = await m.JoinRequest.create({ orgId, userId: u._id, email: u.email });
    await m.User.deleteOne({ _id: u._id }); // deleted without the cascade (a race)
    // Eligibility passes, so the only thing standing between approval and an
    // orphan membership is the requester check.
    orgDomainService.findDiscoverableOrgsByEmail = async () => [{ orgId }];

    await expect(orgDomainService.decideJoinRequest(orgId, String(request._id), 'approve', String(new mongoose.Types.ObjectId())))
      .rejects.toThrow('JOIN_REQUESTER_GONE');
    expect(await m.UserOrganization.countDocuments({ userId: u._id })).toBe(0);
  });

  it.each([
    ['self-serve deleteAccount', (id: string) => userProfileService.deleteAccount(id)],
    ['admin deleteUserById', (id: string) => userAdminService.deleteUserById(id)],
  ])('%s refuses an org owner and deletes nothing', async (_name, del) => {
    const u = await newUser('owner');
    await m.UserOrganization.create({ userId: u._id, organizationId: orgId, role: 'owner' });
    await expect(del(String(u._id))).rejects.toThrow('USER_OWNER_HAS_ORGS');
    expect(await m.User.exists({ _id: u._id })).not.toBeNull();
  });

  it.each([
    ['self-serve deleteAccount', (id: string) => userProfileService.deleteAccount(id)],
    ['admin deleteUserById', (id: string) => userAdminService.deleteUserById(id)],
  ])('%s refuses the last member of a privileged Role, allows it once another member exists', async (_name, del) => {
    const [a, b] = [await newUser('alice'), await newUser('bob')];
    const role = await privilegedRole();
    const member = await m.Role.create({ organizationId: orgId, name: 'Member', grantsRole: 'member', permissions: [] });
    await m.RoleAssignment.create({ userId: a._id, roleId: role._id, organizationId: orgId });
    await m.RoleAssignment.create({ userId: a._id, roleId: member._id, organizationId: orgId });

    await expect(del(String(a._id))).rejects.toThrow('RL_LAST_PRIVILEGED_MEMBER');
    expect(await m.RoleAssignment.countDocuments({ userId: a._id })).toBe(2);

    await m.RoleAssignment.create({ userId: b._id, roleId: role._id, organizationId: orgId });
    await del(String(a._id));
    expect(await m.RoleAssignment.countDocuments({ userId: a._id })).toBe(0);
  });

  it('removeUserFromRole refuses to empty a privileged Role', async () => {
    const a = await newUser('solo');
    await m.UserOrganization.create({ userId: a._id, organizationId: orgId, role: 'admin' });
    const role = await privilegedRole();
    await m.RoleAssignment.create({ userId: a._id, roleId: role._id, organizationId: orgId });

    await expect(rolesService.removeUserFromRole(orgId, String(role._id), String(a._id), { actorIsSuperAdmin: true }))
      .rejects.toThrow('RL_LAST_PRIVILEGED_MEMBER');
    expect(await m.RoleAssignment.countDocuments({ roleId: role._id })).toBe(1);
  });
});
