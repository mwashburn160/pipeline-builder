// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for forgot-password (services/password-reset-service.ts).
 *
 * What must hold, and can't be proved against a mocked collection:
 *   - only the token's SHA-256 is stored, with a TTL index on `expiresAt`;
 *   - no link is minted for an unknown address or a password-less account;
 *   - a reset is SINGLE-USE and refuses an expired token;
 *   - a refused new password leaves the link usable for another try;
 *   - a reset is a HARD revocation: tokenVersion bump, every refresh slot gone,
 *     every access key revoked;
 *   - a new request supersedes the previous link;
 *   - a password sign-in's pending MFA challenge, opened BEFORE the reset,
 *     cannot be finished after it (the challenge is bound to tokenVersion).
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped by default).
 */

import crypto from 'crypto';
import { it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.PASSWORD_BREACH_CHECK = 'off';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('password reset (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, svc: any, apiKeyService: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  let userId: string;

  const AUTH = { amr: ['pwd'] as const, aal: 1 as const, authTime: new Date('2026-01-01T00:00:00Z') };

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    await m.PasswordResetToken.init();
    svc = await import('../src/services/password-reset-service.js');
    ({ apiKeyService } = await import('../src/services/api-key-service.js'));
    (await import('./helpers/signing.js')).installTestSigningKeys();
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Organization, m.PersonalAccessToken, m.PasswordResetToken]) await model.deleteMany({});
    const org = await m.Organization.create({ name: 'Acme', owner: new mongoose.Types.ObjectId(), tier: 'pro' });
    const user = await m.User.create({
      username: 'forgetful',
      email: 'forgetful@example.com',
      password: 'Old-Passw0rd!secret',
      isEmailVerified: true,
      lastActiveOrgId: org._id,
    });
    userId = String(user._id);
    await m.UserOrganization.create({ userId: user._id, organizationId: org._id, role: 'owner', isActive: true });
  });

  it('stores only the hash, behind a TTL index', async () => {
    const out = await svc.requestPasswordReset('Forgetful@Example.com');
    expect(out.dispatched).toBe(true);
    expect(out.rawToken).toMatch(/^[0-9a-f]{64}$/);
    const rows = await m.PasswordResetToken.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(crypto.createHash('sha256').update(out.rawToken).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(out.rawToken);
    const indexes = await m.PasswordResetToken.collection.indexes();
    expect(indexes.find((i: { key: Record<string, number> }) => i.key.expiresAt === 1)?.expireAfterSeconds).toBe(0);
  });

  it('mints nothing for an unknown address or a password-less account', async () => {
    expect(await svc.requestPasswordReset('nobody@example.com')).toEqual({ dispatched: false, reason: 'unknown-email' });
    await m.User.create({ username: 'social', email: 'social@example.com', isEmailVerified: true });
    expect(await svc.requestPasswordReset('social@example.com')).toMatchObject({ dispatched: false, reason: 'no-password' });
    expect(await m.PasswordResetToken.countDocuments({})).toBe(0);
  });

  it('resets once, and ends every session and access key', async () => {
    const { key } = await apiKeyService.create(userId, { name: 'laptop', expiresInSeconds: 86400, client: {} }, AUTH);
    await m.RefreshSession.create({
      userId,
      id: 's1',
      kind: 'interactive',
      tokenVersion: 0,
      hash: 'h',
      createdAt: new Date(),
      lastUsedAt: new Date(),
      authTime: new Date(),
      amr: ['pwd'],
      aal: 1,
      purgeAt: new Date(Date.now() + 86400_000),
    });
    const before = await m.User.findById(userId).select('+tokenVersion').lean();

    const { rawToken } = await svc.requestPasswordReset('forgetful@example.com');
    const result = await svc.resetPassword(rawToken, 'New-Passw0rd!secret');
    expect(result).toMatchObject({ userId, accessKeysRevoked: 1 });

    const after = await m.User.findById(userId).select('+tokenVersion +password');
    expect(after.tokenVersion).toBe((before.tokenVersion ?? 0) + 1);
    expect(await m.RefreshSession.countDocuments({ userId })).toBe(0);
    expect(await after.comparePassword('New-Passw0rd!secret')).toBe(true);
    expect((await apiKeyService.exchange(key)).ok).toBe(false);

    // Single use.
    await expect(svc.resetPassword(rawToken, 'Another-Passw0rd!1')).rejects.toThrow(svc.PASSWORD_RESET_TOKEN_INVALID);
    expect(await m.PasswordResetToken.countDocuments({})).toBe(0);
  });

  it('BUMPS a non-zero tokenVersion — never resets it to 1', async () => {
    // Regression: the reset loaded the user with `'+password +tokenVersion email
    // lastActiveOrgId'`; tokenVersion is not `select: false`, so the `+` dropped
    // it from the projection and `(undefined ?? 0) + 1` wrote 1 — a version
    // REGRESSION that could revive credentials bound to an older version.
    await m.User.updateOne({ _id: userId }, { $set: { tokenVersion: 5 } });
    const { rawToken } = await svc.requestPasswordReset('forgetful@example.com');
    await svc.resetPassword(rawToken, 'New-Passw0rd!secret');
    const after = await m.User.findById(userId).select('tokenVersion').lean();
    expect(after.tokenVersion).toBe(6);
  });

  it('lifts a live failed-password lockout — the guarded password is gone', async () => {
    await m.PasswordLoginLockout.collection.insertOne({
      userId: new mongoose.Types.ObjectId(userId),
      failedAttempts: 0,
      lockedUntil: new Date(Date.now() + 600_000),
      expiresAt: new Date(Date.now() + 600_000),
    });
    const { rawToken } = await svc.requestPasswordReset('forgetful@example.com');
    await svc.resetPassword(rawToken, 'New-Passw0rd!secret');
    expect(await m.PasswordLoginLockout.countDocuments({})).toBe(0);
  });

  it('refuses an expired token', async () => {
    const { rawToken } = await svc.requestPasswordReset('forgetful@example.com');
    await m.PasswordResetToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(svc.resetPassword(rawToken, 'New-Passw0rd!secret')).rejects.toThrow(svc.PASSWORD_RESET_TOKEN_INVALID);
  });

  it('keeps the link usable when the new password is refused', async () => {
    const { rawToken } = await svc.requestPasswordReset('forgetful@example.com');
    await expect(svc.resetPassword(rawToken, 'Old-Passw0rd!secret')).rejects.toThrow(svc.PASSWORD_RESET_UNCHANGED);
    expect(await m.PasswordResetToken.countDocuments({})).toBe(1);
    await expect(svc.resetPassword(rawToken, 'New-Passw0rd!secret')).resolves.toMatchObject({ userId });
  });

  it('a new request supersedes the previous link', async () => {
    const first = await svc.requestPasswordReset('forgetful@example.com');
    const second = await svc.requestPasswordReset('forgetful@example.com');
    expect(await m.PasswordResetToken.countDocuments({})).toBe(1);
    await expect(svc.resetPassword(first.rawToken, 'New-Passw0rd!secret')).rejects.toThrow(svc.PASSWORD_RESET_TOKEN_INVALID);
    await expect(svc.resetPassword(second.rawToken, 'New-Passw0rd!secret')).resolves.toMatchObject({ userId });
  });

  it('kills an MFA sign-in challenge opened before the reset (tokenVersion binding)', async () => {
    const { createMfaChallenge } = await import('../src/services/mfa-challenge.js');
    const { verifyMfaLogin } = await import('../src/controllers/totp.js');
    const { Registry } = await import('prom-client');
    (await import('../src/observability/metrics.js')).setMetricsRegistry(new Registry());
    const before = await m.User.findById(userId).select('+tokenVersion').lean();
    // Leg one happened: the password was proven at the CURRENT tokenVersion.
    const { challengeId } = await createMfaChallenge(userId, undefined, { tokenVersion: before.tokenVersion ?? 0 });

    // ...then the account is reset (by its owner, or by whoever holds the inbox).
    const { rawToken } = await svc.requestPasswordReset('forgetful@example.com');
    await svc.resetPassword(rawToken, 'New-Passw0rd!secret');

    const res: any = { locals: {} };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.cookie = () => res;
    await verifyMfaLogin({ body: { challengeId, code: '123456' }, headers: {}, ip: '127.0.0.1' } as any, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'TOTP_INVALID_CHALLENGE' });
    expect(res.body?.data?.accessToken).toBeUndefined();
  });
});
