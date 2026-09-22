// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo (replica set — provisioning is transactional) test for just-in-time
 * SSO membership + group → Role mapping (3a). What only a real database shows:
 *
 *   - the (orgId, groupKey) unique index, so one group can't carry two rule sets;
 *   - a full sign-in provisioning a membership + the Member floor + mapped Roles,
 *     with the coarse role derived (never `owner`);
 *   - the seat cap refusing the sign-in against live membership/invite counts;
 *   - manual assignments surviving a sync that removes the JIT-owned ones;
 *   - the entitlement off-switch leaving existing memberships and Roles in place.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default) — mirrors
 * user-cascade.integration.test.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('SSO just-in-time provisioning (real Mongo replica set)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, jit: any, mapping: any, roles: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    for (const model of [m.User, m.UserOrganization, m.Role, m.RoleAssignment, m.Organization, m.OrgIdpConfig, m.IdpGroupMapping, m.Invitation]) {
      await model.createCollection().catch(() => undefined);
    }
    await m.IdpGroupMapping.syncIndexes();
    // The provisioning path emits counters, and platform's metrics helper is
    // wired from index.ts on boot — which this suite doesn't run.
    const { Registry } = await import('prom-client');
    const { setMetricsRegistry } = await import('../src/observability/metrics.js');
    setMetricsRegistry(new Registry());
    jit = await import('../src/services/sso-jit-service.js');
    ({ idpGroupMappingService: mapping } = await import('../src/services/idp-group-mapping-service.js'));
    roles = {
      ...(await import('../src/services/roles-service.js')),
      ...(await import('../src/services/role-crud.js')),
    };
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  let orgId: string;
  let memberRoleId: string;
  let engRoleId: string;
  const ADMIN_ACTOR = { isSuperAdmin: false, isOrgAdmin: true, permissions: [] as string[] };

  /** A Team-tier org (so it holds the `sso` entitlement) with its built-in Roles.
   *  Seats are unlimited unless a test narrows them — the model's default comes
   *  from the DEFAULT tier, not the one set here. */
  async function makeOrg(over: Record<string, unknown> = {}): Promise<string> {
    const org = await m.Organization.create({
      name: `Acme-${Math.random().toString(16).slice(2)}`,
      owner: new mongoose.Types.ObjectId(),
      tier: 'team',
      quotas: { seats: -1 },
      ...over,
    });
    const id = String(org._id);
    const owner = await m.User.create({ username: `owner-${id}`, email: `owner-${id}@acme.com`, isEmailVerified: true });
    await m.UserOrganization.create({ userId: owner._id, organizationId: id, role: 'owner' });
    await roles.seedDefaultRoles(id, owner._id);
    return id;
  }

  const newUser = (name: string) => m.User.create({ username: name, email: `${name}@acme.com`, isEmailVerified: true });

  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Role, m.RoleAssignment, m.Organization, m.OrgIdpConfig, m.IdpGroupMapping, m.Invitation]) {
      await model.deleteMany({});
    }
    orgId = await makeOrg();
    await m.OrgIdpConfig.create({
      orgId,
      provider: 'generic-oidc',
      clientId: 'cid',
      clientSecretEncrypted: 'blob',
      discoveryUrl: 'https://idp.test/.well-known/openid-configuration',
      groupsClaim: 'groups',
      createdBy: 'u0',
      updatedBy: 'u0',
    });
    memberRoleId = String((await m.Role.findOne({ organizationId: orgId, grantsRole: 'member' }))._id);
    const eng = await m.Role.create({ organizationId: orgId, name: 'Engineering', grantsRole: 'member', permissions: ['pipelines:write'] });
    engRoleId = String(eng._id);
  });

  it('enforces one mapping per group per org (case-insensitively)', async () => {
    await mapping.create(orgId, 'admin', { group: 'Engineering', roleIds: [engRoleId] }, ADMIN_ACTOR);
    await expect(mapping.create(orgId, 'admin', { group: 'engineering', roleIds: [engRoleId] }, ADMIN_ACTOR))
      .rejects.toThrow('IGM_GROUP_TAKEN');
    // …and the unique index backs the service-level check at the storage layer.
    await expect(m.IdpGroupMapping.create({
      orgId, group: 'ENGINEERING', groupKey: 'engineering', roleIds: [], createdBy: 'x', updatedBy: 'x',
    })).rejects.toThrow();
  });

  it('adds the membership, the Member floor and the mapped Role on first sign-in', async () => {
    await mapping.create(orgId, 'admin', { group: 'engineering', roleIds: [engRoleId] }, ADMIN_ACTOR);
    const user = await newUser('newcomer');

    const out = await jit.provisionJitMembership({ orgId, user, groups: ['Engineering'] });

    expect(out.membershipCreated).toBe(true);
    expect(out.rolesAdded).toEqual([engRoleId]);

    const membership = await m.UserOrganization.findOne({ userId: user._id, organizationId: orgId }).lean();
    // Never owner — a mapping can raise the coarse role through an admin-granting
    // Role, but ownership is never provisioned.
    expect(membership.role).toBe('member');
    expect(membership.isActive).toBe(true);

    const held = await m.RoleAssignment.find({ userId: user._id, organizationId: orgId }).lean();
    expect(held.map((a: { roleId: unknown }) => String(a.roleId)).sort()).toEqual([memberRoleId, engRoleId].sort());
    // The Member floor is a manual grant; only the mapped Role is JIT-owned.
    const byRole = new Map(held.map((a: { roleId: unknown; source: string }) => [String(a.roleId), a.source]));
    expect(byRole.get(memberRoleId)).toBe('manual');
    expect(byRole.get(engRoleId)).toBe('jit');
  });

  it('REFUSES the sign-in when the account has no seats left', async () => {
    await m.Organization.updateOne({ _id: orgId }, { $set: { 'quotas.seats': 1 } }); // owner already holds it
    const user = await newUser('overflow');

    await expect(jit.provisionJitMembership({ orgId, user, groups: [] })).rejects.toThrow('JIT_SEAT_LIMIT');
    expect(await m.UserOrganization.findOne({ userId: user._id, organizationId: orgId })).toBeNull();

    // The pre-flight refuses the same sign-in before an account would be created.
    await expect(jit.assertJitSeatAvailable(orgId, 'brand-new@acme.com')).rejects.toThrow('JIT_SEAT_LIMIT');
  });

  it('keeps a manually assigned Role and drops only the JIT-owned one', async () => {
    const custom = await m.Role.create({ organizationId: orgId, name: 'Manual', grantsRole: 'member', permissions: [] });
    await mapping.create(orgId, 'admin', { group: 'engineering', roleIds: [engRoleId] }, ADMIN_ACTOR);

    const user = await newUser('mixed');
    await jit.provisionJitMembership({ orgId, user, groups: ['engineering'] });
    // An admin then grants a second Role by hand.
    await roles.addUserToRole(orgId, String(custom._id), { userId: String(user._id) }, ADMIN_ACTOR);

    // The IdP drops the group: the mapped Role goes, the hand-granted one stays.
    const out = await jit.provisionJitMembership({ orgId, user, groups: [] });
    expect(out.rolesRemoved).toEqual([engRoleId]);

    const held = (await m.RoleAssignment.find({ userId: user._id, organizationId: orgId }).lean())
      .map((a: { roleId: unknown }) => String(a.roleId));
    expect(held).toContain(String(custom._id));
    expect(held).toContain(memberRoleId);
    expect(held).not.toContain(engRoleId);
  });

  it('never removes a mapped Role the admin re-granted by hand', async () => {
    await mapping.create(orgId, 'admin', { group: 'engineering', roleIds: [engRoleId] }, ADMIN_ACTOR);
    const user = await newUser('claimed');
    await jit.provisionJitMembership({ orgId, user, groups: ['engineering'] });
    // The admin takes ownership of the same assignment.
    await roles.addUserToRole(orgId, engRoleId, { userId: String(user._id) }, ADMIN_ACTOR);

    const out = await jit.provisionJitMembership({ orgId, user, groups: [] });
    expect(out.rolesRemoved).toEqual([]);
    expect(await m.RoleAssignment.exists({ userId: user._id, roleId: engRoleId })).toBeTruthy();
  });

  it('turns JIT off after a downgrade, leaving membership and Roles intact', async () => {
    await mapping.create(orgId, 'admin', { group: 'engineering', roleIds: [engRoleId] }, ADMIN_ACTOR);
    const user = await newUser('downgraded');
    await jit.provisionJitMembership({ orgId, user, groups: ['engineering'] });

    // Drop to a tier without `sso` (and no purchased entitlement).
    await m.Organization.updateOne({ _id: orgId }, { $set: { tier: 'pro', featureEntitlements: [] } });

    const out = await jit.provisionJitMembership({ orgId, user, groups: [] });
    expect(out.skipped).toBe('not-entitled');
    expect(await m.UserOrganization.exists({ userId: user._id, organizationId: orgId })).toBeTruthy();
    expect(await m.RoleAssignment.exists({ userId: user._id, roleId: engRoleId })).toBeTruthy();
  });

  it('only ever touches the SSO org — a second org\'s membership is untouched', async () => {
    const otherOrgId = await makeOrg();
    await mapping.create(orgId, 'admin', { group: 'engineering', roleIds: [engRoleId] }, ADMIN_ACTOR);

    const user = await newUser('multi');
    await jit.provisionJitMembership({ orgId, user, groups: ['engineering'] });

    expect(await m.UserOrganization.exists({ userId: user._id, organizationId: otherOrgId })).toBeNull();
    expect(await m.RoleAssignment.exists({ userId: user._id, organizationId: otherOrgId })).toBeNull();
  });

  it('leaves a deactivated membership deactivated', async () => {
    await mapping.create(orgId, 'admin', { group: 'engineering', roleIds: [engRoleId] }, ADMIN_ACTOR);
    const user = await newUser('suspended');
    await m.UserOrganization.create({ userId: user._id, organizationId: orgId, role: 'member', isActive: false });

    const out = await jit.provisionJitMembership({ orgId, user, groups: ['engineering'] });

    expect(out.skipped).toBe('membership-inactive');
    expect((await m.UserOrganization.findOne({ userId: user._id, organizationId: orgId }).lean()).isActive).toBe(false);
    expect(await m.RoleAssignment.exists({ userId: user._id, roleId: engRoleId })).toBeNull();
  });
});
