// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for the org service-account lifecycle (#2): create → key →
 * exchange → revoke → org cascade.
 *
 * The invariants here are the ones a mocked collection cannot prove:
 *   - a service account holds Roles through the SAME `role_assignments`
 *     collection people use, and its exchanged token carries exactly those
 *     permissions (re-derived per exchange);
 *   - it takes NO seat — creating accounts never moves pooled seat usage;
 *   - its keys are `pb_sa_…`, capped per account, and the raw key exists once;
 *   - the exchange fails closed on: revoked/expired key, disabled account, a
 *     tombstoned org, an IP outside the key's allowlist, and an exhausted
 *     per-account token budget;
 *   - the account survives its CREATOR being deleted, and is removed by the org
 *     cascade (with every key).
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default) — mirrors
 * access-keys.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const RUN = process.env.RUN_MONGO_INTEGRATION === '1' || process.env.RUN_MONGO_INTEGRATION === 'true';
const suite = RUN ? describe : describe.skip;

suite('service accounts (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, sa: any, apiKeyService: any, token: any, seats: any, roles: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /** A platform superadmin actor — the widest ceiling, so role assignment is never the thing under test. */
  const SUPER: { isSuperAdmin: true; isOrgAdmin: true; permissions: string[]; userId?: string; email?: string } = {
    isSuperAdmin: true, isOrgAdmin: true, permissions: [],
  };

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    sa = await import('../src/services/service-account-service.js');
    ({ apiKeyService } = await import('../src/services/api-key-service.js'));
    token = await import('../src/utils/token.js');
    seats = await import('../src/helpers/seats.js');
    roles = await import('../src/services/roles-service.js');
    (await import('./helpers/signing.js')).installTestSigningKeys();
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  let orgId: string;
  let creatorId: string;
  let adminRoleId: string;

  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Organization, m.PersonalAccessToken, m.ServiceAccount, m.Role, m.RoleAssignment]) {
      await model.deleteMany({});
    }
    const org = await m.Organization.create({ name: 'Acme', owner: new mongoose.Types.ObjectId(), tier: 'pro' });
    orgId = String(org._id);
    const creator = await m.User.create({
      username: 'creator', email: 'creator@example.com', password: 'Passw0rd!secret', isEmailVerified: true, lastActiveOrgId: org._id,
    });
    creatorId = String(creator._id);
    await m.UserOrganization.create({ userId: creator._id, organizationId: org._id, role: 'admin', isActive: true });
    await roles.seedDefaultRoles(org._id, creator._id);
    adminRoleId = String((await m.Role.findOne({ organizationId: org._id, grantsRole: 'admin' }).lean())._id);
  });

  const createAccount = (overrides: Record<string, unknown> = {}) => sa.createServiceAccount(
    orgId,
    { name: 'ci-deploy', description: 'CI', roleIds: [adminRoleId], ...overrides },
    { ...SUPER, userId: creatorId, email: 'creator@example.com' },
  );

  it('creates an account that holds its roles through role_assignments and takes no seat', async () => {
    const before = await seats.pooledSeatUsage(orgId);
    const account = await createAccount();

    expect(account.name).toBe('ci-deploy');
    expect(account.seatsConsumed).toBe(0);
    expect(account.roles.map((r: { id: string }) => r.id)).toEqual([adminRoleId]);
    expect(account.permissions).toContain('pipelines:write');

    // The assignment row is an ordinary role_assignments doc, keyed by the
    // ACCOUNT — no membership row, hence no seat.
    const assignment = await m.RoleAssignment.findOne({ serviceAccountId: account.id }).lean();
    expect(String(assignment.roleId)).toBe(adminRoleId);
    expect(assignment.userId ?? null).toBeNull();
    expect(await m.UserOrganization.countDocuments({ organizationId: new mongoose.Types.ObjectId(orgId) })).toBe(1);

    const after = await seats.pooledSeatUsage(orgId);
    expect(after.used).toBe(before.used);
  });

  it('lists every account with its roles and keys (in bulk, not per account)', async () => {
    const first = await createAccount({ name: 'ci-deploy' });
    const second = await createAccount({ name: 'reporting-bot', roleIds: [] });
    await sa.createServiceAccountKey(orgId, first.id, { name: 'k1', expiresInSeconds: 86400 });
    await sa.createServiceAccountKey(orgId, first.id, { name: 'k2', expiresInSeconds: 86400 });

    const listed = await sa.listServiceAccounts(orgId);
    expect(listed.map((a: { name: string }) => a.name)).toEqual(['reporting-bot', 'ci-deploy']);

    const ci = listed.find((a: { id: string }) => a.id === first.id);
    expect(ci.keys.map((k: { name: string }) => k.name).sort()).toEqual(['k1', 'k2']);
    expect(ci.roles.map((r: { id: string }) => r.id)).toEqual([adminRoleId]);
    expect(ci.permissions).toContain('pipelines:write');

    // The role-less account is rendered with EMPTY sets, not the other's.
    const reporting = listed.find((a: { id: string }) => a.id === second.id);
    expect(reporting.roles).toEqual([]);
    expect(reporting.keys).toEqual([]);
    expect(reporting.permissions).toEqual([]);
  });

  it('refuses a duplicate name in the same org', async () => {
    await createAccount();
    await expect(createAccount()).rejects.toThrow('SA_NAME_TAKEN');
  });

  it('issues a pb_sa_ key whose secret is stored only as a hash, and caps active keys at five', async () => {
    const account = await createAccount();
    const { key, view } = await sa.createServiceAccountKey(orgId, account.id, { name: 'k1', expiresInSeconds: 86400 });

    expect(key).toMatch(/^pb_sa_[A-Za-z0-9_-]{43}$/);
    expect(view.kind).toBe('service_account');
    expect(view.serviceAccountId).toBe(account.id);
    const doc = await m.PersonalAccessToken.findById(view.id).lean();
    expect(JSON.stringify(doc)).not.toContain(key);

    for (let i = 2; i <= 5; i++) {
      await sa.createServiceAccountKey(orgId, account.id, { name: `k${i}`, expiresInSeconds: 86400 });
    }
    await expect(sa.createServiceAccountKey(orgId, account.id, { name: 'k6', expiresInSeconds: 86400 }))
      .rejects.toThrow('SA_KEY_LIMIT');
  });

  it('refuses a key lifetime beyond 365 days', async () => {
    const account = await createAccount();
    await expect(sa.createServiceAccountKey(orgId, account.id, { name: 'k', expiresInSeconds: 366 * 86400 }))
      .rejects.toThrow('SA_KEY_EXPIRY_INVALID');
  });

  it('exchanges a key for a service_account token carrying the account, its org and its permissions', async () => {
    const account = await createAccount();
    const { key } = await sa.createServiceAccountKey(orgId, account.id, { name: 'k', expiresInSeconds: 86400 });

    const result = await apiKeyService.exchange(key);
    expect(result.ok).toBe(true);
    expect(result.principalType).toBe('service_account');
    expect(result.serviceAccountName).toBe('ci-deploy');

    const claims = token.verifyAccessToken(result.accessToken);
    expect(claims).toMatchObject({
      sub: account.id,
      principalType: 'service_account',
      token_use: 'api_key',
      organizationId: orgId,
      role: 'admin',
      aal: 1,
    });
    // No human authentication to inherit — which is what stops it satisfying
    // any assurance requirement — and no session to revoke.
    expect(claims.amr).toEqual([]);
    expect(claims.tokenVersion).toBeUndefined();
    expect(claims.permissions).toContain('pipelines:write');
    expect(claims.isSuperAdmin).toBeUndefined();
  });

  it('re-derives permissions on every exchange, so a role change lands within one token lifetime', async () => {
    const account = await createAccount();
    const { key } = await sa.createServiceAccountKey(orgId, account.id, { name: 'k', expiresInSeconds: 86400 });
    expect(token.verifyAccessToken((await apiKeyService.exchange(key)).accessToken).role).toBe('admin');

    await sa.updateServiceAccount(orgId, account.id, { roleIds: [] }, SUPER);
    const claims = token.verifyAccessToken((await apiKeyService.exchange(key)).accessToken);
    expect(claims.role).toBe('member');
    expect(claims.permissions).toEqual([]);
  });

  it('fails closed on a revoked key, a disabled account and a tombstoned org', async () => {
    const account = await createAccount();
    const { key, view } = await sa.createServiceAccountKey(orgId, account.id, { name: 'k', expiresInSeconds: 86400 });

    await sa.updateServiceAccount(orgId, account.id, { disabled: true }, SUPER);
    expect(await apiKeyService.exchange(key)).toEqual({ ok: false, reason: 'account_disabled' });

    await sa.updateServiceAccount(orgId, account.id, { disabled: false }, SUPER);
    await m.Organization.updateOne({ _id: new mongoose.Types.ObjectId(orgId) }, { $set: { deletedAt: new Date() } });
    expect(await apiKeyService.exchange(key)).toEqual({ ok: false, reason: 'authority_revoked' });

    await m.Organization.updateOne({ _id: new mongoose.Types.ObjectId(orgId) }, { $set: { deletedAt: null } });
    await sa.revokeServiceAccountKey(orgId, account.id, view.id);
    expect(await apiKeyService.exchange(key)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('enforces a key IP allowlist at exchange', async () => {
    const account = await createAccount();
    const { key } = await sa.createServiceAccountKey(orgId, account.id, {
      name: 'k', expiresInSeconds: 86400, ipAllowlist: ['203.0.113.0/24'],
    });

    expect((await apiKeyService.exchange(key, '203.0.113.7')).ok).toBe(true);
    expect(await apiKeyService.exchange(key, '198.51.100.9')).toEqual({ ok: false, reason: 'ip_not_allowed' });
    // Unknown presenting address with an allowlist set: deny, never "can't tell".
    expect(await apiKeyService.exchange(key, undefined)).toEqual({ ok: false, reason: 'ip_not_allowed' });
  });

  it('meters the account OWN token budget and refuses once it is spent', async () => {
    const account = await createAccount({ tokenBudget: 2 });
    const { key } = await sa.createServiceAccountKey(orgId, account.id, { name: 'k', expiresInSeconds: 86400 });

    expect((await apiKeyService.exchange(key)).ok).toBe(true);
    expect((await apiKeyService.exchange(key)).ok).toBe(true);
    expect(await apiKeyService.exchange(key)).toEqual({ ok: false, reason: 'budget_exhausted' });

    const view = await sa.getServiceAccount(orgId, account.id);
    expect(view.usage.exchanges).toBe(2);

    // The budget is the ACCOUNT's, not the org's: the org's seat usage and its
    // members' access are untouched by an exhausted machine budget.
    expect((await seats.pooledSeatUsage(orgId)).used).toBe(1);
  });

  it('is not orphaned when its creator is deleted', async () => {
    const account = await createAccount();
    const { key } = await sa.createServiceAccountKey(orgId, account.id, { name: 'k', expiresInSeconds: 86400 });

    // Delete the creator the way the account-deletion cascade does.
    const { deleteUserCascade } = await import('../src/services/user-cascade.js');
    const session = await mongoose.startSession();
    await m.UserOrganization.updateOne({ userId: new mongoose.Types.ObjectId(creatorId) }, { $set: { role: 'admin' } });
    await deleteUserCascade(session, creatorId);
    await session.endSession();

    expect(await m.ServiceAccount.countDocuments({})).toBe(1);
    expect((await apiKeyService.exchange(key)).ok).toBe(true);
    const view = await sa.getServiceAccount(orgId, account.id);
    // The attribution snapshot outlives the person.
    expect(view.createdByEmail).toBe('creator@example.com');
  });

  it('deletes accounts, their keys and their role assignments with the org', async () => {
    const account = await createAccount();
    await sa.createServiceAccountKey(orgId, account.id, { name: 'k', expiresInSeconds: 86400 });

    const removed = await sa.deleteServiceAccountsForOrg(orgId);
    expect(removed).toEqual({ accounts: 1, keys: 1 });
    expect(await m.ServiceAccount.countDocuments({})).toBe(0);
    expect(await m.PersonalAccessToken.countDocuments({ prefix: 'pb_sa' })).toBe(0);
    expect(await m.RoleAssignment.countDocuments({ serviceAccountId: { $ne: null } })).toBe(0);
  });

  it('revokes (but keeps) every key when the org is soft-deleted', async () => {
    const account = await createAccount();
    const { key } = await sa.createServiceAccountKey(orgId, account.id, { name: 'k', expiresInSeconds: 86400 });

    expect(await sa.revokeServiceAccountKeysForOrg(orgId)).toBe(1);
    expect(await apiKeyService.exchange(key)).toEqual({ ok: false, reason: 'revoked' });
    expect(await m.ServiceAccount.countDocuments({})).toBe(1);
  });

  it('refuses to assign a role the actor does not hold (the creator ceiling)', async () => {
    const delegate = { isSuperAdmin: false, isOrgAdmin: false, permissions: ['service_accounts:manage'] };
    await expect(sa.createServiceAccount(orgId, { name: 'sneaky', roleIds: [adminRoleId] }, delegate))
      .rejects.toThrow('RL_ASSIGN_EXCEEDS_CEILING');
    // …and the refused create leaves nothing behind.
    expect(await m.ServiceAccount.countDocuments({ name: 'sneaky' })).toBe(0);
  });

  // ── Scoped keys (#12) ────────────────────────────────────────────────────
  //
  // A scoped key is the least-privilege shape: the exchanged token carries the
  // one capability INSTEAD of the account's Roles, which is what lets an org
  // give an ingest or a push credential to automation without giving it the
  // account's whole authority.

  it('mints a SCOPED key whose exchanged token drops the account\'s roles entirely', async () => {
    const account = await createAccount(); // admin role → pipelines:write etc.
    const { key } = await sa.createServiceAccountKey(orgId, account.id, {
      name: 'ingest', expiresInSeconds: 86400, scope: 'reporting:ingest',
    });

    const result = await apiKeyService.exchange(key);
    expect(result.ok).toBe(true);
    expect(result.scope).toBe('reporting:ingest');

    const claims = token.verifyAccessToken(result.accessToken);
    expect(claims.scope).toBe('reporting:ingest');
    // Least privilege, despite the account holding the admin Role.
    expect(claims.permissions).toEqual([]);
    expect(claims.isAdmin).toBe(false);
    expect(claims.isSuperAdmin).toBeUndefined();
    expect(claims.role).toBe('member');
    expect(claims.principalType).toBe('service_account');
  });

  it('refuses a key scope outside the catalog', async () => {
    const account = await createAccount();
    await expect(sa.createServiceAccountKey(orgId, account.id, {
      name: 'bogus', expiresInSeconds: 86400, scope: 'registry:destroy',
    })).rejects.toThrow('SA_INVALID_SCOPE');
  });

  // ── Self-rotation (#N2) ──────────────────────────────────────────────────
  //
  // The ordering is the invariant: ROTATE leaves the presented key live, and
  // REVOKE refuses to retire the key it was authenticated with. Together those
  // two rules mean an unattended rotator can fail at any step and still hold a
  // working credential.

  it('rotates a key into a live sibling that inherits scope, allowlist and lifetime', async () => {
    const account = await createAccount();
    const { key, view } = await sa.createServiceAccountKey(orgId, account.id, {
      name: 'ingest', expiresInSeconds: 86400, scope: 'reporting:ingest', ipAllowlist: ['10.0.0.0/8'],
    });

    const rotated = await apiKeyService.rotateServiceAccountKey(key, {}, '10.1.2.3');
    expect(rotated.ok).toBe(true);
    expect(rotated.previousKeyId).toBe(view.id);
    expect(rotated.key.startsWith('pb_sa_')).toBe(true);
    expect(rotated.key).not.toBe(key);
    expect(rotated.view.scope).toBe('reporting:ingest');
    expect(rotated.view.ipAllowlist).toEqual(['10.0.0.0/8']);
    // Lifetime carried over from the key it replaces (~1 day), not reset to the default.
    const lifeMs = new Date(rotated.view.expiresAt).getTime() - Date.now();
    expect(lifeMs).toBeGreaterThan(80_000_000);
    expect(lifeMs).toBeLessThan(90_000_000);

    // BOTH work until the caller retires the old one — that is what makes a
    // failure between "rotate" and "store" survivable.
    expect((await apiKeyService.exchange(key, '10.1.2.3')).ok).toBe(true);
    expect((await apiKeyService.exchange(rotated.key, '10.1.2.3')).ok).toBe(true);
  });

  it('retires the predecessor with the NEW key, and refuses to let a key revoke itself', async () => {
    const account = await createAccount();
    const { key, view } = await sa.createServiceAccountKey(orgId, account.id, { name: 'k', expiresInSeconds: 86400 });
    const rotated = await apiKeyService.rotateServiceAccountKey(key);

    // A key may never revoke ITSELF here: the rotator would destroy the very
    // credential it is holding.
    expect(await apiKeyService.revokeSiblingKey(rotated.key, rotated.view.id))
      .toEqual({ ok: false, reason: 'self_revoke' });

    const revoked = await apiKeyService.revokeSiblingKey(rotated.key, view.id);
    expect(revoked.ok).toBe(true);
    expect(revoked.alreadyRevoked).toBe(false);
    expect(await apiKeyService.exchange(key)).toEqual({ ok: false, reason: 'revoked' });
    expect((await apiKeyService.exchange(rotated.key)).ok).toBe(true);

    // Idempotent: a retrying rotator that already revoked must not see a failure.
    const again = await apiKeyService.revokeSiblingKey(rotated.key, view.id);
    expect(again).toMatchObject({ ok: true, alreadyRevoked: true });
  });

  it('self-heals past the active-key cap by retiring the oldest sibling — never the presented key', async () => {
    const account = await createAccount();
    const issued = [];
    for (let i = 0; i < sa.MAX_ACTIVE_KEYS_PER_ACCOUNT; i++) {
      issued.push(await sa.createServiceAccountKey(orgId, account.id, { name: `k${i}`, expiresInSeconds: 86400 }));
      // Distinct createdAt so "oldest" is unambiguous.
      await new Promise((r) => setTimeout(r, 5));
    }
    // Rotate the NEWEST key: the oldest sibling is what must go.
    const presented = issued[issued.length - 1];
    const rotated = await apiKeyService.rotateServiceAccountKey(presented.key);

    expect(rotated.ok).toBe(true);
    expect(rotated.prunedKeyIds).toEqual([issued[0].view.id]);
    expect(await apiKeyService.exchange(issued[0].key)).toEqual({ ok: false, reason: 'revoked' });
    // The presented key survived the pruning and is still usable.
    expect((await apiKeyService.exchange(presented.key)).ok).toBe(true);
  });

  it('refuses to rotate a PERSONAL key — a person has a UI and step-up', async () => {
    const auth = { amr: ['pwd'], aal: 1, authTime: new Date() };
    const { key } = await apiKeyService.create(creatorId, { name: 'mine', expiresInSeconds: 86400 }, auth);
    expect(await apiKeyService.rotateServiceAccountKey(key))
      .toEqual({ ok: false, reason: 'not_service_account' });
  });

  it('refuses to rotate a revoked, expired or disabled-account key', async () => {
    const account = await createAccount();
    const live = await sa.createServiceAccountKey(orgId, account.id, { name: 'live', expiresInSeconds: 86400 });
    const dead = await sa.createServiceAccountKey(orgId, account.id, { name: 'dead', expiresInSeconds: 86400 });
    await sa.revokeServiceAccountKey(orgId, account.id, dead.view.id);

    expect(await apiKeyService.rotateServiceAccountKey(dead.key)).toEqual({ ok: false, reason: 'revoked' });
    expect(await apiKeyService.rotateServiceAccountKey('pb_sa_nope')).toEqual({ ok: false, reason: 'malformed' });

    await sa.updateServiceAccount(orgId, account.id, { disabled: true }, SUPER);
    expect(await apiKeyService.rotateServiceAccountKey(live.key)).toEqual({ ok: false, reason: 'account_disabled' });
  });

  it('refuses to rotate from an address outside the key\'s allowlist', async () => {
    const account = await createAccount();
    const { key } = await sa.createServiceAccountKey(orgId, account.id, {
      name: 'pinned', expiresInSeconds: 86400, ipAllowlist: ['10.0.0.0/8'],
    });
    expect(await apiKeyService.rotateServiceAccountKey(key, {}, '203.0.113.9'))
      .toEqual({ ok: false, reason: 'ip_not_allowed' });
  });

  it('refuses a rotation lifetime beyond the 365-day ceiling', async () => {
    const account = await createAccount();
    const { key } = await sa.createServiceAccountKey(orgId, account.id, { name: 'k', expiresInSeconds: 86400 });
    expect(await apiKeyService.rotateServiceAccountKey(key, { expiresInSeconds: 400 * 24 * 60 * 60 }))
      .toEqual({ ok: false, reason: 'expiry_invalid' });
    expect(await apiKeyService.rotateServiceAccountKey(key, { expiresInSeconds: 1 }))
      .toEqual({ ok: false, reason: 'expiry_invalid' });
  });
});
