// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo (replica set — the tombstone is transactional) test for the org /
 * team SOFT-DELETE and the account self-delete built on it.
 *
 *   - Soft-deleting a team ends its members' access to THAT team only: a claims
 *     bump (their access tokens go stale at once and `requireAuth` refuses them),
 *     never a sign-out — their sessions and their other orgs survive, and the
 *     next refresh lands in an org they are still in.
 *   - The tombstone write is conditional on the org not being deleted already,
 *     so a repeat (racing) delete cannot reset `purgeAfter`.
 *   - Account self-delete tombstones the sole-owned org and deletes the account
 *     in ONE transaction: a failure in the user cascade leaves the org live (and
 *     the account intact) rather than half-deleted.
 *
 * Postgres is stubbed (the snapshot export reads it; its rows are not what is
 * under test). Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default).
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

// pipeline-data: the strict snapshot export reads every org-scoped Postgres
// table — answer each with no rows. The REAL ownership map (deep import, schema only).
const ownership = await import('@pipeline-builder/pipeline-data/lib/api/org-data-ownership.js') as typeof import('@pipeline-builder/pipeline-data');
const emptySelect = { from: () => emptySelect, where: async () => [] };
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({ select: () => emptySelect }),
  ORG_DATA_OWNERSHIP: ownership.ORG_DATA_OWNERSHIP,
  ORG_SCOPED_TABLE_NAMES: ownership.ORG_SCOPED_TABLE_NAMES,
  allOrgScopedTables: ownership.allOrgScopedTables,
  runWithTenantContext: <T>(_ctx: unknown, fn: () => Promise<T>): Promise<T> => fn(),
  softDeleteRetentionMs: () => 30 * 24 * 60 * 60 * 1000,
}));

suite('org soft-delete (real Mongo replica set)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, cascade: any, token: any, authMw: any, authCtl: any, jwt: any, roles: any, profile: any, snapshots: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    const { default: DeletedOrgSnapshot } = await import('../src/models/deleted-org-snapshot.js');
    snapshots = DeletedOrgSnapshot;
    // Collections must exist before a transaction writes to them.
    for (const model of Object.values(m) as any[]) {
      if (typeof model?.createCollection === 'function') await model.createCollection().catch(() => undefined);
    }
    await snapshots.createCollection().catch(() => undefined);
    await m.RefreshSession.init();
    cascade = await import('../src/services/org-cascade-service.js');
    token = {
      ...(await import('../src/services/session/refresh-sessions.js')),
      ...(await import('../src/services/session/access-tokens.js')),
    };
    authMw = await import('../src/middleware/auth.js');
    authCtl = await import('../src/controllers/auth.js');
    jwt = (await import('jsonwebtoken')).default;
    roles = await import('../src/services/roles-service.js');
    ({ userProfileService: profile } = await import('../src/services/user-profile-service.js'));
    (await import('./helpers/signing.js')).installTestSigningKeys();
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Organization, m.RefreshSession, m.Role, m.RoleAssignment, m.PersonalAccessToken, snapshots]) {
      await model.deleteMany({});
    }
  });

  function res() {
    const r: any = { locals: {} };
    r.status = jest.fn(() => r);
    r.json = jest.fn(() => r);
    r.cookie = jest.fn(() => r);
    r.clearCookie = jest.fn(() => r);
    return r;
  }

  /** requireAuth over a Bearer access token → the HTTP status it answered (200 = admitted). */
  async function authStatus(accessToken: string): Promise<number> {
    const r = res();
    let admitted = false;
    await authMw.requireAuth({ headers: { authorization: `Bearer ${accessToken}` }, method: 'GET' }, r, () => { admitted = true; });
    return admitted ? 200 : r.status.mock.calls[0]?.[0];
  }

  /** POST /auth/refresh (CLI transport) → status + the new token pair. */
  async function refresh(refreshToken: string): Promise<{ status: number; body: any }> {
    const req: any = { body: { refreshToken }, headers: {} };
    const r = res();
    let passed = false;
    await authMw.requireRefreshSession(req, r, () => { passed = true; });
    if (passed) await authCtl.refresh(req, r);
    return { status: r.status.mock.calls[0]?.[0], body: r.json.mock.calls[0]?.[0] };
  }

  const loadUser = (id: unknown) => m.User.findById(id).select('+tokenVersion +isSuperAdmin');
  const signIn = async (userId: unknown, orgId: string) => token.issueTokens(await loadUser(userId), orgId, {
    kind: 'interactive', auth: token.signInAuth('pwd'), client: { userAgent: 'jest', ip: '203.0.113.7' },
  });
  const orgOf = (t: string) => (jwt.decode(t) as { organizationId?: string }).organizationId;

  async function org(name: string, owner: unknown, extra: Record<string, unknown> = {}): Promise<string> {
    const o = await m.Organization.create({ name, owner, tier: 'team', quotas: { seats: -1 }, ...extra });
    await roles.seedDefaultRoles(String(o._id), owner);
    return String(o._id);
  }
  async function join(userId: unknown, orgId: string, role = 'member'): Promise<void> {
    await m.UserOrganization.create({ userId, organizationId: orgId, role });
    await roles.ensureBaselineRole(userId, new mongoose.Types.ObjectId(orgId));
  }

  describe('team soft-delete', () => {
    let rootId: string;
    let teamId: string;
    let memberId: unknown;
    beforeEach(async () => {
      const owner = await m.User.create({ username: 'owner', email: 'owner@acme.com', isEmailVerified: true });
      rootId = await org('Acme', owner._id);
      await m.UserOrganization.create({ userId: owner._id, organizationId: rootId, role: 'owner' });
      teamId = await org('Acme Eng', owner._id, { parentOrgId: new mongoose.Types.ObjectId(rootId) });
      const member = await m.User.create({ username: 'dev', email: 'dev@acme.com', isEmailVerified: true });
      memberId = member._id;
      await join(memberId, rootId);
      await join(memberId, teamId);
    });

    it('does NOT sign members out of their other orgs: sessions survive, the team token is refused, the next refresh lands in a live org', async () => {
      const inTeam = await signIn(memberId, teamId);
      const inRoot = await signIn(memberId, rootId);
      expect(orgOf(inTeam.accessToken)).toBe(teamId);
      expect(await authStatus(inTeam.accessToken)).toBe(200);
      const before = await loadUser(memberId);

      await cascade.softDeleteOrg(teamId, rootId, 'admin-1');

      // Access to the TEAM ends immediately: the token scoped to it is refused.
      expect(await authStatus(inTeam.accessToken)).toBe(401);
      // ...but it is not a sign-out: the hard version and both slots survive.
      const after = await loadUser(memberId);
      expect(after.tokenVersion).toBe(before.tokenVersion);
      expect(await m.RefreshSession.countDocuments({ userId: memberId })).toBe(2);
      // The team session's refresh re-mints into an org the member is still in.
      const renewed = await refresh(inTeam.refreshToken);
      expect(renewed.status).toBe(200);
      expect(orgOf(renewed.body.data.accessToken)).toBe(rootId);
      expect(await authStatus(renewed.body.data.accessToken)).toBe(200);
      // The other device keeps working through a refresh too.
      expect((await refresh(inRoot.refreshToken)).status).toBe(200);
      // The pin on the dead team is dropped, so a NEW sign-in never lands there.
      expect(String(after.lastActiveOrgId ?? '')).not.toBe(teamId);
    });

    it('still revokes the members\' PATs scoped to the deleted team — and only those', async () => {
      const pat = (orgId: string, name: string) => m.PersonalAccessToken.create({
        userId: memberId,
        organizationId: orgId,
        name,
        prefix: 'pb_pat',
        keyHash: `h-${name}`,
        last4: 'abcd',
        aal: 1,
        authTime: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      const teamPat = await pat(teamId, 'team');
      const rootPat = await pat(rootId, 'root');

      await cascade.softDeleteOrg(teamId, rootId, 'admin-1');

      expect((await m.PersonalAccessToken.findById(teamPat._id).lean()).revoked).toBe(true);
      expect((await m.PersonalAccessToken.findById(rootPat._id).lean()).revoked).toBe(false);
    });

    it('a PLATFORM delete is a takedown: a tenant cannot restore it, and the listing says so', async () => {
      const { organizationService } = await import('../src/services/organization-service.js');
      const { orgHierarchyService } = await import('../src/services/org-hierarchy-service.js');
      await cascade.softDeleteOrg(teamId, rootId, 'operator-1', { byPlatform: true });
      expect((await m.Organization.findById(teamId).lean()).deletedByPlatform).toBe(true);

      expect((await orgHierarchyService.listDeletedTeams(rootId, false)).teams).toEqual([
        expect.objectContaining({ orgId: teamId, deletedByPlatform: true, restorable: false }),
      ]);
      await expect(organizationService.restore(teamId, 'admin-1', false)).rejects.toThrow('ORG_RESTORE_PLATFORM_DELETED');
      expect((await m.Organization.findById(teamId).lean()).deletedAt).toBeTruthy();

      expect((await orgHierarchyService.listDeletedTeams(rootId, true)).teams[0]).toMatchObject({ restorable: true });
      await organizationService.restore(teamId, 'operator-1', true);
      const live = await m.Organization.findById(teamId).lean();
      expect(live.deletedAt).toBeNull();
      expect(live.deletedByPlatform).toBeUndefined();
    });

    it('a tenant\'s own team delete stays self-serve restorable', async () => {
      const { organizationService } = await import('../src/services/organization-service.js');
      const { orgHierarchyService } = await import('../src/services/org-hierarchy-service.js');
      await cascade.softDeleteOrg(teamId, rootId, 'admin-1');
      expect((await orgHierarchyService.listDeletedTeams(rootId, false)).teams[0]).toMatchObject({ deletedByPlatform: false, restorable: true });
      await organizationService.restore(teamId, 'admin-1', false);
      expect((await m.Organization.findById(teamId).lean()).deletedAt).toBeNull();
    });

    it('a racing repeat delete cannot reset purgeAfter: exactly one tombstone lands, the other is ORG_ALREADY_DELETED', async () => {
      const results = await Promise.allSettled([
        cascade.softDeleteOrg(teamId, rootId, 'admin-1'),
        cascade.softDeleteOrg(teamId, rootId, 'admin-2'),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled') as Array<PromiseFulfilledResult<{ purgeAfter: Date }>>;
      const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(won).toHaveLength(1);
      expect(lost.map((r) => r.reason.message)).toEqual(['ORG_ALREADY_DELETED']);
      const stored = await m.Organization.findById(teamId).lean();
      expect(stored.purgeAfter.getTime()).toBe(won[0].value.purgeAfter.getTime());
    });
  });

  describe('account self-delete', () => {
    let userId: unknown;
    let soleOrgId: string;
    beforeEach(async () => {
      const u = await m.User.create({ username: 'solo', email: 'solo@acme.com', isEmailVerified: true });
      userId = u._id;
      soleOrgId = await org('Solo', userId);
      await m.UserOrganization.create({ userId, organizationId: soleOrgId, role: 'owner' });
      await roles.ensureBaselineRole(userId, new mongoose.Types.ObjectId(soleOrgId));
    });

    it('when the user cascade fails, the sole-owned org is NOT left tombstoned (nothing half-done)', async () => {
      const real = m.UserPreferences.deleteMany;
      m.UserPreferences.deleteMany = () => { throw new Error('transient datastore failure'); };
      try {
        await expect(profile.deleteAccount(String(userId))).rejects.toThrow('transient datastore failure');
      } finally {
        m.UserPreferences.deleteMany = real;
      }

      expect((await m.Organization.findById(soleOrgId).lean()).deletedAt ?? null).toBeNull();
      expect(await m.User.exists({ _id: userId })).not.toBeNull();
      // No recovery snapshot is left behind for an org that was never deleted.
      expect(await snapshots.countDocuments({ organizationId: new mongoose.Types.ObjectId(soleOrgId) })).toBe(0);
    });

    it('deletes the account and tombstones the sole-owned org together', async () => {
      const out = await profile.deleteAccount(String(userId));
      expect(out.orgsDeleted.map((o: { orgId: string }) => o.orgId)).toEqual([soleOrgId]);
      expect(await m.User.exists({ _id: userId })).toBeNull();
      const tomb = await m.Organization.findById(soleOrgId).lean();
      expect(tomb.deletedAt).toBeInstanceOf(Date);
      expect(await snapshots.countDocuments({ organizationId: new mongoose.Types.ObjectId(soleOrgId) })).toBe(1);
    });
  });
});
