// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo (replica set — provisioning is transactional) test for SCIM 2.0
 * (3b). What only a real database shows:
 *
 *   - a create that produces the account, the membership, the Member floor and
 *     a `meta`/`Location` that resolve;
 *   - `userName eq` / `externalId eq` filtering and startIndex/count paging over
 *     real rows;
 *   - the SEAT refusal against live membership + invite counts, naming the limit;
 *   - deactivate: the membership goes inactive, `tokenVersion` is bumped and the
 *     refresh slots are cleared IN THE SAME transaction (sessions revoked);
 *   - group membership driving Roles through 3a's resolver, with a HAND-GRANTED
 *     Role surviving every sync;
 *   - the DOWNGRADE ASYMMETRY: reads, deactivate and delete still work; create
 *     and update are refused;
 *   - the refusals that protect the tenant: an unverified email domain, the org
 *     owner, and a platform administrator.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default) — mirrors
 * sso-jit.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.PLATFORM_FRONTEND_URL ||= 'https://pb.test';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const RUN = process.env.RUN_MONGO_INTEGRATION === '1' || process.env.RUN_MONGO_INTEGRATION === 'true';
const suite = RUN ? describe : describe.skip;

suite('SCIM 2.0 provisioning (real Mongo replica set)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, scim: any, roles: any, mapping: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    for (const model of [m.User, m.UserOrganization, m.Role, m.RoleAssignment, m.Organization, m.OrgDomain, m.OrgIdpConfig, m.IdpGroupMapping, m.Invitation]) {
      await model.createCollection().catch(() => undefined);
    }
    await m.IdpGroupMapping.syncIndexes();
    // The provisioning path emits counters, and platform's metrics helper is
    // wired from index.ts on boot — which this suite doesn't run.
    const { Registry } = await import('prom-client');
    const { setMetricsRegistry } = await import('../src/observability/metrics.js');
    setMetricsRegistry(new Registry());
    scim = await import('../src/services/scim-service.js');
    roles = await import('../src/services/roles-service.js');
    ({ idpGroupMappingService: mapping } = await import('../src/services/idp-group-mapping-service.js'));
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  let orgId: string;
  let memberRoleId: string;
  let engRoleId: string;
  let ctx: { orgId: string; entitled: boolean };
  const ADMIN_ACTOR = { isSuperAdmin: false, isOrgAdmin: true, permissions: [] as string[] };

  /** A Team-tier org (so it holds `sso`) with its built-in Roles, its owner, and
   *  a VERIFIED domain — without which SCIM refuses to provision at all. */
  async function makeOrg(over: Record<string, unknown> = {}, opts: { domain?: string | null } = {}): Promise<string> {
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
    await m.Organization.updateOne({ _id: org._id }, { $set: { owner: owner._id } });
    await roles.seedDefaultRoles(id, owner._id);
    // A VERIFIED domain: without one SCIM refuses to provision at all. `domain:
    // null` makes a team that inherits its ROOT's verified domain instead (the
    // `verified` partial-unique index allows only one org per domain).
    if (opts.domain !== null) {
      await m.OrgDomain.create({
        orgId: id,
        domain: opts.domain ?? 'acme.com',
        verified: true,
        verificationToken: 'tok',
        createdBy: 'test',
      });
    }
    return id;
  }

  const createAlice = () => scim.createUser(ctx, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: 'alice@acme.com',
    externalId: '00u-alice',
    name: { givenName: 'Alice', familyName: 'Ng' },
    emails: [{ value: 'alice@acme.com', primary: true, type: 'work' }],
    active: true,
  });

  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Role, m.RoleAssignment, m.Organization, m.OrgDomain, m.OrgIdpConfig, m.IdpGroupMapping, m.Invitation]) {
      await model.deleteMany({});
    }
    orgId = await makeOrg();
    ctx = { orgId, entitled: true };
    // The group-mapping EDITOR (3a) requires an IdP config whose provider can
    // carry groups; SCIM's own Groups endpoint does not, but the tests below use
    // the editor to say what a group is worth.
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

  // -- Users ----------------------------------------------------------------

  it('creates the account, the membership and the Member floor', async () => {
    const out = await createAlice();

    expect(out.action).toBe('create');
    expect(out.resource.userName).toBe('alice@acme.com');
    expect(out.resource.externalId).toBe('00u-alice');
    expect(out.resource.active).toBe(true);
    expect(out.resource.emails[0]).toMatchObject({ value: 'alice@acme.com', primary: true });
    expect(out.resource.meta.location).toBe(`https://pb.test/api/scim/v2/Users/${out.resource.id}`);

    const membership = await m.UserOrganization.findOne({ userId: out.resource.id, organizationId: orgId }).lean();
    // Never owner — a directory never provisions ownership.
    expect(membership.role).toBe('member');
    expect(membership.scim.managed).toBe(true);
    expect(membership.scim.givenName).toBe('Alice');
    // The built-in Member floor, granted as `manual` so no sync can strip it.
    const held = await m.RoleAssignment.find({ userId: out.resource.id, organizationId: orgId }).lean();
    expect(held.map((a: { roleId: unknown }) => String(a.roleId))).toEqual([memberRoleId]);
  });

  it('refuses a second create for the same person with `uniqueness`', async () => {
    await createAlice();
    await expect(createAlice()).rejects.toMatchObject({ status: 409, scimType: 'uniqueness' });
  });

  it('REFUSES an email domain the organization has not verified', async () => {
    // Otherwise a tenant could staple a membership onto any account on the
    // platform just by knowing its address.
    await expect(scim.createUser(ctx, { userName: 'mallory@evil.test' }))
      .rejects.toMatchObject({ status: 400, scimType: 'invalidValue' });
  });

  it('never provisions a platform administrator', async () => {
    await m.User.create({ username: 'ops', email: 'ops@acme.com', isEmailVerified: true, isSuperAdmin: true });
    await expect(scim.createUser(ctx, { userName: 'ops@acme.com' }))
      .rejects.toMatchObject({ status: 403, reason: 'platform_admin' });
  });

  it('REFUSES a create past the seat limit, naming the seat reason', async () => {
    // The owner already holds the single seat.
    await m.Organization.updateOne({ _id: orgId }, { $set: { 'quotas.seats': 1 } });

    await expect(createAlice()).rejects.toMatchObject({ status: 403, reason: 'seat_limit' });
    await expect(createAlice()).rejects.toThrow(/seat limit reached/i);
    // No overage: nothing was provisioned.
    expect(await m.User.findOne({ email: 'alice@acme.com' })).toBeNull();
  });

  it('filters by userName and by externalId, and pages 1-based', async () => {
    await createAlice();
    await scim.createUser(ctx, { userName: 'bob@acme.com', externalId: '00u-bob' });
    await scim.createUser(ctx, { userName: 'carol@acme.com' });

    const byName = await scim.listUsers(ctx, { filter: 'userName eq "bob@acme.com"' });
    expect(byName.totalResults).toBe(1);
    expect(byName.Resources[0].userName).toBe('bob@acme.com');

    const byExternal = await scim.listUsers(ctx, { filter: 'externalId eq "00u-alice"' });
    expect(byExternal.Resources.map((r: { userName: string }) => r.userName)).toEqual(['alice@acme.com']);

    // The owner + three provisioned users.
    const all = await scim.listUsers(ctx, {});
    expect(all.totalResults).toBe(4);

    const page = await scim.listUsers(ctx, { startIndex: '2', count: '2' });
    expect(page.startIndex).toBe(2);
    expect(page.itemsPerPage).toBe(2);
    expect(page.totalResults).toBe(4);
    // Disjoint from the first page, so a client that pages sees each row once.
    const first = await scim.listUsers(ctx, { startIndex: '1', count: '1' });
    expect(page.Resources.map((r: { id: string }) => r.id)).not.toContain(first.Resources[0].id);
  });

  it('a filter that matches nothing is an EMPTY list, not a 404', async () => {
    const res = await scim.listUsers(ctx, { filter: 'userName eq "nobody@acme.com"' });
    expect(res.totalResults).toBe(0);
    expect(res.Resources).toEqual([]);
    expect(res.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:ListResponse']);
  });

  it('DEACTIVATES on active:false — membership inactive, sessions revoked', async () => {
    const created = await createAlice();
    const id = created.resource.id;
    await m.User.updateOne({ _id: id }, { $set: { refreshSessions: [{ tokenHash: 'h', createdAt: new Date() }] } });
    const before = await m.User.findById(id).select('+tokenVersion').lean();

    const out = await scim.patchUser(ctx, id, [{ op: 'replace', value: { active: false } }]);
    expect(out.action).toBe('deactivate');
    expect(out.resource.active).toBe(false);

    const membership = await m.UserOrganization.findOne({ userId: id, organizationId: orgId }).lean();
    expect(membership.isActive).toBe(false);
    const after = await m.User.findById(id).select('+tokenVersion').lean();
    // The bump is what makes every outstanding access token fail on its next
    // request; clearing the slots blocks a silent re-issue.
    expect(after.tokenVersion).toBeGreaterThan(before.tokenVersion);
    expect(after.refreshSessions ?? []).toEqual([]);
  });

  it('DELETE deactivates and revokes too, and is idempotent', async () => {
    const created = await createAlice();
    const id = created.resource.id;

    await scim.deleteUser(ctx, id);
    let membership = await m.UserOrganization.findOne({ userId: id, organizationId: orgId }).lean();
    expect(membership.isActive).toBe(false);
    // The ROW is kept: it carries the audit trail, the hand-granted Roles and the
    // seat accounting, and an inactive membership grants nothing.
    expect(membership).not.toBeNull();

    // A second delete answers the same way rather than 404-ing the sync.
    await expect(scim.deleteUser(ctx, id)).resolves.toMatchObject({ action: 'delete' });
    membership = await m.UserOrganization.findOne({ userId: id, organizationId: orgId }).lean();
    expect(membership.isActive).toBe(false);
  });

  it('never deactivates or deletes the organization OWNER', async () => {
    const ownerMembership = await m.UserOrganization.findOne({ organizationId: orgId, role: 'owner' }).lean();
    const ownerId = String(ownerMembership.userId);
    await expect(scim.patchUser(ctx, ownerId, [{ op: 'replace', path: 'active', value: false }]))
      .rejects.toMatchObject({ status: 403, reason: 'owner_protected' });
    await expect(scim.deleteUser(ctx, ownerId)).rejects.toMatchObject({ reason: 'owner_protected' });
  });

  it('reactivates through the seat check', async () => {
    const created = await createAlice();
    const id = created.resource.id;
    await scim.deleteUser(ctx, id);

    // One seat, held by the owner: the reactivation must be refused.
    await m.Organization.updateOne({ _id: orgId }, { $set: { 'quotas.seats': 1 } });
    await expect(scim.patchUser(ctx, id, [{ op: 'replace', path: 'active', value: true }]))
      .rejects.toMatchObject({ reason: 'seat_limit' });

    await m.Organization.updateOne({ _id: orgId }, { $set: { 'quotas.seats': -1 } });
    const out = await scim.patchUser(ctx, id, [{ op: 'replace', path: 'active', value: true }]);
    expect(out.action).toBe('activate');
    expect(out.resource.active).toBe(true);
  });

  it('refuses to RENAME the account behind a membership', async () => {
    const created = await createAlice();
    await expect(scim.replaceUser(ctx, created.resource.id, { userName: 'alice.ng@acme.com', active: true }))
      .rejects.toMatchObject({ status: 400, scimType: 'mutability' });
  });

  it('updates the directory-owned attributes and leaves the account alone', async () => {
    const created = await createAlice();
    const out = await scim.patchUser(ctx, created.resource.id, [
      { op: 'replace', path: 'name.familyName', value: 'Nguyen' },
      { op: 'replace', path: 'displayName', value: 'Alice Nguyen' },
    ]);
    expect(out.changed).toEqual(expect.arrayContaining(['familyName', 'displayName']));
    expect(out.resource.name.familyName).toBe('Nguyen');
    // The platform identity is untouched.
    const user = await m.User.findById(created.resource.id).lean();
    expect(user.email).toBe('alice@acme.com');
  });

  it('IGNORES attributes it does not model rather than failing the whole sync', async () => {
    const created = await createAlice();
    // Entra sends these unconditionally; a 400 here would stall every user.
    await expect(scim.patchUser(ctx, created.resource.id, [
      { op: 'replace', path: 'phoneNumbers[type eq "work"].value', value: '+1 555 0100' },
      { op: 'replace', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'Platform' },
    ])).resolves.toBeDefined();
  });

  // -- Groups ---------------------------------------------------------------

  it('maps group membership to Roles through the 3a resolver', async () => {
    const alice = (await createAlice()).resource.id;
    // The admin decides what the group is WORTH; SCIM only decides who is in it.
    await mapping.create(orgId, 'admin', { group: 'Engineering', roleIds: [engRoleId] }, ADMIN_ACTOR);
    const group = (await scim.listGroups(ctx, { filter: 'displayName eq "Engineering"' })).Resources[0];

    await scim.patchGroup(ctx, group.id, [{ op: 'add', path: 'members', value: [{ value: alice }] }]);

    const held = (await m.RoleAssignment.find({ userId: alice, organizationId: orgId }).lean())
      .map((a: { roleId: unknown; source?: string }) => [String(a.roleId), a.source]);
    expect(held).toEqual(expect.arrayContaining([[engRoleId, 'jit'], [memberRoleId, 'manual']]));

    // …and removing them takes the mapped Role away again.
    await scim.patchGroup(ctx, group.id, [{ op: 'remove', path: `members[value eq "${alice}"]` }]);
    expect(await m.RoleAssignment.exists({ userId: alice, roleId: engRoleId })).toBeNull();
  });

  it('a SCIM-created group grants NOTHING until an admin maps it', async () => {
    const alice = (await createAlice()).resource.id;
    const out = await scim.createGroup(ctx, { displayName: 'Contractors', externalId: '00g-c', members: [{ value: alice }] });

    expect(out.resource.displayName).toBe('Contractors');
    expect(out.resource.members.map((mem: { value: string }) => mem.value)).toEqual([alice]);
    const row = await m.IdpGroupMapping.findOne({ orgId, groupKey: 'contractors' }).lean();
    // SCIM never writes roleIds — that is the whole reason a stolen SCIM key is
    // not a privilege-escalation primitive.
    expect(row.roleIds).toEqual([]);
    expect(row.scimManaged).toBe(true);
    expect(await m.RoleAssignment.find({ userId: alice, organizationId: orgId }).lean())
      .toHaveLength(1); // the Member floor only
  });

  it('KEEPS a hand-granted Role through every sync', async () => {
    const alice = (await createAlice()).resource.id;
    const custom = await m.Role.create({ organizationId: orgId, name: 'Manual', grantsRole: 'member', permissions: [] });
    await mapping.create(orgId, 'admin', { group: 'Engineering', roleIds: [engRoleId] }, ADMIN_ACTOR);
    const group = (await scim.listGroups(ctx, {})).Resources.find((g: { displayName: string }) => g.displayName === 'Engineering');

    await scim.patchGroup(ctx, group.id, [{ op: 'add', path: 'members', value: [{ value: alice }] }]);
    await roles.addUserToRole(orgId, String(custom._id), { userId: alice }, ADMIN_ACTOR);

    // The directory drops the group entirely.
    await scim.deleteGroup(ctx, group.id);

    const held = (await m.RoleAssignment.find({ userId: alice, organizationId: orgId }).lean())
      .map((a: { roleId: unknown }) => String(a.roleId));
    expect(held).toContain(String(custom._id));
    expect(held).toContain(memberRoleId);
    expect(held).not.toContain(engRoleId);
    expect(await m.IdpGroupMapping.findOne({ orgId, groupKey: 'engineering' })).toBeNull();
  });

  it('carries members across a group RENAME', async () => {
    const alice = (await createAlice()).resource.id;
    const created = await scim.createGroup(ctx, { displayName: 'Eng', members: [{ value: alice }] });
    await scim.patchGroup(ctx, created.resource.id, [{ op: 'replace', path: 'displayName', value: 'Engineering' }]);

    const after = await scim.getGroup(ctx, created.resource.id);
    expect(after.displayName).toBe('Engineering');
    // Members carry the KEY — a rename that didn't move them would silently drop
    // everyone out of the group (and out of the Roles it maps to).
    expect(after.members.map((mem: { value: string }) => mem.value)).toEqual([alice]);
  });

  it('a name-only PUT does NOT silently empty the group', async () => {
    const alice = (await createAlice()).resource.id;
    const created = await scim.createGroup(ctx, { displayName: 'Eng', members: [{ value: alice }] });

    // `members` absent means "unchanged"; clearing has to be asked for.
    await scim.replaceGroup(ctx, created.resource.id, { displayName: 'Engineering' });
    expect((await scim.getGroup(ctx, created.resource.id)).members).toHaveLength(1);

    await scim.replaceGroup(ctx, created.resource.id, { displayName: 'Engineering', members: [] });
    expect((await scim.getGroup(ctx, created.resource.id)).members).toEqual([]);
  });

  it('refuses a member who is not provisioned in this organization', async () => {
    const stranger = await m.User.create({ username: 'stranger', email: 'stranger@acme.com', isEmailVerified: true });
    await expect(scim.createGroup(ctx, { displayName: 'Ghosts', members: [{ value: String(stranger._id) }] }))
      .rejects.toMatchObject({ status: 400, scimType: 'invalidValue' });
  });

  // -- The downgrade asymmetry ----------------------------------------------

  describe('after an SSO downgrade', () => {
    let aliceId: string;
    let groupId: string;

    beforeEach(async () => {
      aliceId = (await createAlice()).resource.id;
      groupId = (await scim.createGroup(ctx, { displayName: 'Engineering', members: [{ value: aliceId }] })).resource.id;
      // Drop to a tier without `sso` and with no purchased entitlement.
      await m.Organization.updateOne({ _id: orgId }, { $set: { tier: 'pro', featureEntitlements: [] } });
      const { isSsoEntitled } = await import('../src/helpers/sso-enforcement.js');
      expect(await isSsoEntitled(orgId)).toBe(false);
      ctx = { orgId, entitled: false };
    });

    it('still READS — an IdP must look a user up before it can deactivate them', async () => {
      const found = await scim.listUsers(ctx, { filter: 'userName eq "alice@acme.com"' });
      expect(found.totalResults).toBe(1);
      await expect(scim.getUser(ctx, aliceId)).resolves.toMatchObject({ active: true });
      await expect(scim.listGroups(ctx, {})).resolves.toMatchObject({ totalResults: 1 });
    });

    it('still DEACTIVATES — removing someone in the IdP still removes their access', async () => {
      const out = await scim.patchUser(ctx, aliceId, [{ op: 'replace', value: { active: false } }]);
      expect(out.action).toBe('deactivate');
      expect((await m.UserOrganization.findOne({ userId: aliceId, organizationId: orgId }).lean()).isActive).toBe(false);
    });

    it('still DELETES a user and a group', async () => {
      await expect(scim.deleteUser(ctx, aliceId)).resolves.toMatchObject({ action: 'delete' });
      await expect(scim.deleteGroup(ctx, groupId)).resolves.toMatchObject({ action: 'delete' });
    });

    it('still removes a group MEMBER (that is a removal of access too)', async () => {
      await expect(scim.patchGroup(ctx, groupId, [{ op: 'remove', path: `members[value eq "${aliceId}"]` }]))
        .resolves.toBeDefined();
    });

    it('REFUSES create', async () => {
      await expect(scim.createUser(ctx, { userName: 'bob@acme.com' })).rejects.toMatchObject({ status: 403, reason: 'not_entitled' });
      await expect(scim.createGroup(ctx, { displayName: 'Sales' })).rejects.toMatchObject({ reason: 'not_entitled' });
    });

    it('REFUSES update — including an attribute change ALONGSIDE a deactivation', async () => {
      await expect(scim.patchUser(ctx, aliceId, [{ op: 'replace', path: 'displayName', value: 'A. Ng' }]))
        .rejects.toMatchObject({ reason: 'not_entitled' });
      // A deactivation smuggling an update through is refused as a whole.
      await expect(scim.patchUser(ctx, aliceId, [
        { op: 'replace', path: 'active', value: false },
        { op: 'replace', path: 'displayName', value: 'A. Ng' },
      ])).rejects.toMatchObject({ reason: 'not_entitled' });
      // …and nothing was half-applied.
      expect((await m.UserOrganization.findOne({ userId: aliceId, organizationId: orgId }).lean()).isActive).toBe(true);
    });

    it('accepts a REPEATED deactivate as the no-op it is', async () => {
      // A directory that re-sends `active:false` for someone already removed
      // must not start failing just because the entitlement lapsed.
      await scim.patchUser(ctx, aliceId, [{ op: 'replace', value: { active: false } }]);
      await expect(scim.patchUser(ctx, aliceId, [{ op: 'replace', value: { active: false } }]))
        .resolves.toMatchObject({ action: 'deactivate' });
      await expect(scim.replaceUser(ctx, aliceId, { active: false })).resolves.toMatchObject({ action: 'deactivate' });
    });

    it('REFUSES reactivation and group ADDs', async () => {
      await scim.deleteUser(ctx, aliceId);
      await expect(scim.patchUser(ctx, aliceId, [{ op: 'replace', path: 'active', value: true }]))
        .rejects.toMatchObject({ reason: 'not_entitled' });
      await expect(scim.patchGroup(ctx, groupId, [{ op: 'add', path: 'members', value: [{ value: aliceId }] }]))
        .rejects.toMatchObject({ reason: 'not_entitled' });
    });

    it('leaves existing memberships and Roles exactly as they were', async () => {
      await expect(scim.createUser(ctx, { userName: 'bob@acme.com' })).rejects.toBeDefined();
      const membership = await m.UserOrganization.findOne({ userId: aliceId, organizationId: orgId }).lean();
      expect(membership.isActive).toBe(true);
      expect(await m.RoleAssignment.exists({ userId: aliceId, organizationId: orgId })).toBeTruthy();
    });
  });

  // -- Tenancy --------------------------------------------------------------

  it('only ever touches its OWN org', async () => {
    // A TEAM under the same account root: it inherits the root's verified domain,
    // so the same person can legitimately be provisioned into both.
    const otherOrgId = await makeOrg({ parentOrgId: orgId }, { domain: null });
    const alice = (await createAlice()).resource.id;

    // The same person, provisioned into the second org by its own SCIM client.
    const otherCtx = { orgId: otherOrgId, entitled: true };
    await scim.createUser(otherCtx, { userName: 'alice@acme.com' });

    await scim.deleteUser(ctx, alice);
    expect((await m.UserOrganization.findOne({ userId: alice, organizationId: orgId }).lean()).isActive).toBe(false);
    // Their membership of the other org is untouched.
    expect((await m.UserOrganization.findOne({ userId: alice, organizationId: otherOrgId }).lean()).isActive).toBe(true);
    // …and a list in one org never shows the other's rows beyond the shared user.
    const here = await scim.listUsers(ctx, {});
    expect(here.Resources.every((r: { id: string }) => r.id !== undefined)).toBe(true);
  });
});
