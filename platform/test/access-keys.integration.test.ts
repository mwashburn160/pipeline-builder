// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for the opaque-access-key lifecycle: create → exchange →
 * revoke, plus the authority re-checks the exchange performs on every call.
 *
 * These are the invariants that make the exchange design sound, and none of them
 * can be proved against a mocked collection:
 *   - the raw key is returned ONCE and only its SHA-256 lands in the DB;
 *   - a key exchanges for a short-lived `token_use: 'api_key'` JWT whose claims
 *     are RE-DERIVED each time (so a demotion reaches it within one lifetime);
 *   - revoked / expired / unknown keys are refused, with the reason recorded but
 *     never differentiated to the caller;
 *   - losing the membership or the org the key names refuses the exchange rather
 *     than issuing a token with no tenant;
 *   - `lastUsedAt` is stamped on every exchange (that is what makes the keys
 *     page accurate no matter which service the key was used against).
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default) — mirrors
 * user-cascade.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('access keys (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, apiKeyService: any, token: any, apiKeyUtils: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const AUTH = { amr: ['pwd'] as const, aal: 1 as const, authTime: new Date('2026-01-01T00:00:00Z') };

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    ({ apiKeyService } = await import('../src/services/api-key-service.js'));
    token = await import('../src/utils/token.js');
    apiKeyUtils = await import('@pipeline-builder/api-core');
    // Platform signs every user token with ES256; install an in-memory key so
    // an exchanged key token can be minted (and verified) here.
    (await import('./helpers/signing.js')).installTestSigningKeys();
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Organization, m.PersonalAccessToken]) await model.deleteMany({});
    const org = await m.Organization.create({ name: 'Acme', owner: new mongoose.Types.ObjectId(), tier: 'pro' });
    orgId = String(org._id);
    const user = await m.User.create({
      username: 'keyholder', email: 'keys@example.com', password: 'Passw0rd!secret', isEmailVerified: true, lastActiveOrgId: org._id,
    });
    userId = String(user._id);
    await m.UserOrganization.create({ userId: user._id, organizationId: org._id, role: 'admin', isActive: true });
  });

  async function createKey(overrides: Record<string, unknown> = {}) {
    return apiKeyService.create(
      userId,
      { name: 'ci-deploy', expiresInSeconds: 90 * 86400, client: { userAgent: 'pipeline-manager CLI on macOS', ip: '203.0.113.7' }, ...overrides },
      AUTH,
    );
  }

  it('returns the raw key once and stores only its hash', async () => {
    const { key, view } = await createKey();

    expect(key).toMatch(/^pb_pat_[A-Za-z0-9_-]{43}$/);
    expect(view.display).toBe(`pb_pat_…${key.slice(-4)}`);
    expect(view.kind).toBe('personal');
    expect(view.createdFrom).toBe('pipeline-manager CLI on macOS');
    expect(view.neverUsed).toBe(true);
    expect(view.expiringSoon).toBe(false);

    const doc = await m.PersonalAccessToken.findById(view.id).lean();
    expect(doc.keyHash).toBe(apiKeyUtils.hashApiKey(key));
    // The secret must not survive anywhere in the record.
    expect(JSON.stringify(doc)).not.toContain(key);
    expect(JSON.stringify(doc)).not.toContain(key.slice(7, 20));
  });

  it('exchanges for a short-lived api_key token carrying the key id and live claims', async () => {
    const { key, view } = await createKey();

    const result = await apiKeyService.exchange(key);
    expect(result.ok).toBe(true);
    expect(result.keyId).toBe(view.id);
    expect(result.expiresIn).toBe(apiKeyUtils.API_KEY_TOKEN_TTL_SECONDS);

    const claims = token.verifyAccessToken(result.accessToken);
    expect(claims).toMatchObject({
      sub: userId,
      principalType: 'user',
      token_use: 'api_key',
      jti: view.id,
      organizationId: orgId,
      role: 'admin',
      aal: 1,
    });
    // The assurance is the CREATING session's, copied verbatim — exchanging can
    // never raise the level the person actually signed in at.
    expect(claims.amr).toEqual(['pwd']);
    expect(claims.auth_time).toBe(Math.floor(AUTH.authTime.getTime() / 1000));
    // Short-lived by construction: that window IS the revocation latency.
    expect((claims as { exp: number }).exp - (claims as { iat: number }).iat)
      .toBe(apiKeyUtils.API_KEY_TOKEN_TTL_SECONDS);
  });

  it('stamps last-used on every exchange', async () => {
    const { key, view } = await createKey();
    expect((await m.PersonalAccessToken.findById(view.id).lean()).lastUsedAt).toBeNull();

    await apiKeyService.exchange(key);
    // The stamp is best-effort/non-blocking, so give the write a tick to land.
    await new Promise((r) => setTimeout(r, 50));
    const first = (await m.PersonalAccessToken.findById(view.id).lean()).lastUsedAt;
    expect(first).toBeTruthy();
    expect((await apiKeyService.list(userId))[0].neverUsed).toBe(false);
  });

  it('re-derives claims each exchange, so a role change reaches the key', async () => {
    const { key } = await createKey();
    expect(token.verifyAccessToken((await apiKeyService.exchange(key)).accessToken).role).toBe('admin');

    await m.UserOrganization.updateOne({ userId, organizationId: orgId }, { $set: { role: 'member' } });

    expect(token.verifyAccessToken((await apiKeyService.exchange(key)).accessToken).role).toBe('member');
  });

  it('refuses a revoked key, and the revocation is visible in the listing', async () => {
    const { key, view } = await createKey();
    expect((await apiKeyService.exchange(key)).ok).toBe(true);

    const revoked = await apiKeyService.revoke(userId, view.id);
    expect(revoked.status).toBe('revoked');
    expect(await apiKeyService.exchange(key)).toEqual({ ok: false, reason: 'revoked' });
    // Revoking twice is not an error the caller can use to probe — it simply
    // matches nothing the second time.
    expect(await apiKeyService.revoke(userId, view.id)).toBeNull();
  });

  it('never lets one user revoke another user\'s key', async () => {
    const { key, view } = await createKey();
    const other = await m.User.create({ username: 'other', email: 'other@example.com', password: 'Passw0rd!secret' });

    expect(await apiKeyService.revoke(String(other._id), view.id)).toBeNull();
    expect((await apiKeyService.exchange(key)).ok).toBe(true);
  });

  it('refuses an expired key', async () => {
    const { key, view } = await createKey({ expiresInSeconds: 60 });
    await m.PersonalAccessToken.updateOne({ _id: view.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await apiKeyService.exchange(key)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses an unknown or malformed key', async () => {
    expect(await apiKeyService.exchange(apiKeyUtils.generateApiKey('pb_pat'))).toEqual({ ok: false, reason: 'unknown' });
    expect(await apiKeyService.exchange('not-a-key')).toEqual({ ok: false, reason: 'malformed' });
    // `pb_sa_` is reserved until service accounts ship: well-formed, but nothing
    // can have minted one, so it must not resolve.
    expect(await apiKeyService.exchange(apiKeyUtils.generateApiKey('pb_sa'))).toEqual({ ok: false, reason: 'unknown' });
  });

  it('refuses the exchange when the membership it names is gone', async () => {
    const { key } = await createKey();
    await m.UserOrganization.updateOne({ userId, organizationId: orgId }, { $set: { isActive: false } });

    // Fail CLOSED: issuing an org-less token here would silently let the key act
    // outside every tenant boundary it was created under.
    expect(await apiKeyService.exchange(key)).toEqual({ ok: false, reason: 'authority_revoked' });
  });

  it('refuses the exchange when the org was soft-deleted', async () => {
    const { key } = await createKey();
    await m.Organization.updateOne({ _id: orgId }, { $set: { deletedAt: new Date() } });

    expect(await apiKeyService.exchange(key)).toEqual({ ok: false, reason: 'authority_revoked' });
  });

  it('refuses the exchange when the owner is gone', async () => {
    const { key } = await createKey();
    await m.User.deleteOne({ _id: userId });

    expect(await apiKeyService.exchange(key)).toEqual({ ok: false, reason: 'user_gone' });
  });

  it('carries a narrow scope through to the exchanged token at least privilege', async () => {
    const { key } = await createKey({ scope: 'reporting:ingest' });

    const claims = token.verifyAccessToken((await apiKeyService.exchange(key)).accessToken);
    expect(claims.scope).toBe('reporting:ingest');
    // A scoped credential is minted least-privilege regardless of the creator's
    // own role — that is what stops an admin's key from becoming an admin token.
    expect(claims.role).toBe('member');
    expect(claims.permissions).toEqual([]);
    expect(claims.features).toEqual([]);
  });

  it('flags a key expiring within the next fortnight', async () => {
    const { view } = await createKey({ expiresInSeconds: 3 * 86400 });
    const listed = (await apiKeyService.list(userId)).find((k: { id: string }) => k.id === view.id);
    expect(listed.expiringSoon).toBe(true);
    expect(listed.status).toBe('active');
  });

  it('caps the number of live keys a user may hold', async () => {
    const { PROFILE_PAT_LIMIT } = await import('../src/services/user-errors.js');
    // 50 live keys is the cap; create them directly to keep the test quick.
    const docs = Array.from({ length: 50 }, (_, i) => ({
      userId: new mongoose.Types.ObjectId(userId),
      keyHash: apiKeyUtils.hashApiKey(`filler-${i}`),
      prefix: 'pb_pat',
      last4: 'aaaa',
      name: `k${i}`,
      amr: ['pwd'],
      aal: 1,
      authTime: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    }));
    await m.PersonalAccessToken.insertMany(docs);

    await expect(createKey()).rejects.toThrow(PROFILE_PAT_LIMIT);
  });

  it('revoking every key of a user stops each of them exchanging', async () => {
    const a = await createKey({ name: 'a' });
    const b = await createKey({ name: 'b' });

    await apiKeyService.revokeAllForUser(userId);

    expect((await apiKeyService.exchange(a.key)).ok).toBe(false);
    expect((await apiKeyService.exchange(b.key)).ok).toBe(false);
  });

  // -- Catalog-scoped keys ("Selected permissions") ---------------------------

  describe('permission-scoped keys', () => {
    let roleId: unknown;

    beforeEach(async () => {
      for (const model of [m.Role, m.RoleAssignment]) await model.deleteMany({});
      const role = await m.Role.create({
        organizationId: new mongoose.Types.ObjectId(orgId),
        name: 'Builders',
        permissions: ['pipelines:read', 'pipelines:write', 'plugins:read'],
      });
      roleId = role._id;
      await m.RoleAssignment.create({
        userId: new mongoose.Types.ObjectId(userId), roleId, organizationId: new mongoose.Types.ObjectId(orgId),
      });
    });

    it('stores the subset, lists it, and exchanges for subset ∩ current permissions', async () => {
      const { key, view } = await createKey({ permissions: ['pipelines:read', 'billing:read'] });
      expect(view.permissions).toEqual(['pipelines:read', 'billing:read']);
      expect((await apiKeyService.list(userId))[0].permissions).toEqual(['pipelines:read', 'billing:read']);

      const claims = token.verifyAccessToken((await apiKeyService.exchange(key)).accessToken);
      // billing:read is in the subset but no Role grants it — it never appears.
      expect(claims.permissions).toEqual(['pipelines:read']);
      expect(claims.permissionsRestricted).toBe(true);
      // The admin role label would bypass the subset through isAdmin gates.
      expect(claims.role).toBe('member');
    });

    it('a lost Role shrinks the key at its next exchange; a new Role never grows it', async () => {
      const { key } = await createKey({ permissions: ['pipelines:read', 'plugins:read'] });
      expect(token.verifyAccessToken((await apiKeyService.exchange(key)).accessToken).permissions)
        .toEqual(['pipelines:read', 'plugins:read']);

      await m.Role.updateOne({ _id: roleId }, { $set: { permissions: ['plugins:read', 'org:settings', 'billing:manage'] } });
      expect(token.verifyAccessToken((await apiKeyService.exchange(key)).accessToken).permissions)
        .toEqual(['plugins:read']);
    });

    it('an unscoped key still carries the owner\'s full current permissions', async () => {
      const { key, view } = await createKey();
      expect(view.permissions).toBeNull();
      const claims = token.verifyAccessToken((await apiKeyService.exchange(key)).accessToken);
      expect(claims.permissions).toEqual(['pipelines:read', 'pipelines:write', 'plugins:read']);
      expect(claims.permissionsRestricted).toBeUndefined();
    });

    it('a machine session keeps its subset across renewals and refuses a different one', async () => {
      const user = await m.User.findById(userId).select('+tokenVersion +isSuperAdmin');
      const issued = await token.issueTokens(user, orgId, { kind: 'machine', auth: AUTH, permissions: ['plugins:read'] });
      const sid = token.verifyAccessToken(issued.accessToken).sid;
      expect(token.verifyAccessToken(issued.accessToken).permissions).toEqual(['plugins:read']);

      const renewed = await token.renewSessionTokens(user, orgId, { sessionId: sid, kind: 'machine' });
      expect(token.verifyAccessToken(renewed.accessToken).permissions).toEqual(['plugins:read']);

      const { TOKEN_SCOPE_ESCALATION } = await import('../src/services/auth-errors.js');
      await expect(token.renewSessionTokens(user, orgId, { sessionId: sid, kind: 'machine' }, { permissions: ['pipelines:write'] }))
        .rejects.toThrow(TOKEN_SCOPE_ESCALATION);
      // Asking for full access on a narrowed slot is a widening, too.
      await expect(token.renewSessionTokens(user, orgId, { sessionId: sid, kind: 'machine' }, { permissions: ['pipelines:read', 'plugins:read'] }))
        .rejects.toThrow(TOKEN_SCOPE_ESCALATION);
    });
  });
});
