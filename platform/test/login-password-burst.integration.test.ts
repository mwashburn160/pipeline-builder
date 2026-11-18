// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /auth/login under a PARALLEL burst of wrong passwords — the real route,
 * the real controller, the real durable lockout, real Mongo.
 *
 * Regression: the login controller checked the lockout (`assertNotLocked`), then
 * compared the password, then recorded the failure. A burst fired in parallel
 * passed the check all at once — no failure had been recorded yet — so every
 * request ran a password compare and the `maxFailures` budget meant nothing
 * against concurrency. The controller now RESERVES an attempt atomically before
 * the compare, so at most `maxFailures` compares run and the rest are refused
 * (429) unchecked.
 *
 * The per-IP / per-account Redis-style limiters are raised out of the way here
 * so the durable lockout is the only bound being measured.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped by default).
 */

import { it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.PASSWORD_BREACH_CHECK = 'off';
process.env.LOGIN_ACCOUNT_LOCKOUT_MAX_FAILURES = '3';
process.env.LOGIN_ACCOUNT_LOCKOUT_MS = '60000';
process.env.LOGIN_ACCOUNT_LOCKOUT_WINDOW_MS = '30000';
process.env.LOGIN_ACCOUNT_LIMITER_MAX = '1000';
process.env.AUTH_LIMITER_MAX = '1000';
delete process.env.REDIS_URL;
delete process.env.REDIS_SENTINELS;

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const PASSWORD = 'Passw0rd!Passw0rd';
const BURST = 12;
const suite = integrationSuite();

suite('POST /auth/login — parallel wrong-password burst (real routes, real Mongo)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, harness: any;
  let call: (method: string, path: string, opts?: Record<string, unknown>) => Promise<{ status: number; body: any }>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  let stub: { close: () => Promise<void>; port: number };
  let app: { base: string; close: () => Promise<void> };

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();

    const { startStubServices } = await import('./helpers/stub-services.js');
    stub = await startStubServices();
    process.env.MESSAGE_SERVICE_HOST = '127.0.0.1';
    process.env.MESSAGE_SERVICE_PORT = String(stub.port);
    process.env.QUOTA_SERVICE_HOST = '127.0.0.1';
    process.env.QUOTA_SERVICE_PORT = String(stub.port);

    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    await m.PasswordLoginLockout.syncIndexes();
    harness = await import('./helpers/platform-app.js');
    (await import('./helpers/signing.js')).installTestSigningKeys();
    const { Registry } = await import('prom-client');
    (await import('../src/observability/metrics.js')).setMetricsRegistry(new Registry());
    app = await harness.startPlatformApp();
    call = harness.client(app.base);
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    if (stub) await stub.close();
    if (mongoose) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Organization, m.PasswordLoginLockout, m.RefreshSession]) await model.deleteMany({});
    const org = await m.Organization.create({ name: 'Acme', owner: new mongoose.Types.ObjectId(), tier: 'pro' });
    const user = await m.User.create({
      username: 'pat',
      email: 'pat@example.com',
      password: PASSWORD,
      isEmailVerified: true,
      lastActiveOrgId: org._id,
    });
    await m.UserOrganization.create({ userId: user._id, organizationId: org._id, role: 'member', isActive: true });
  });

  it(`a burst of ${BURST} parallel wrong passwords runs at most maxFailures (3) password compares; the rest are refused unchecked`, async () => {
    const compare = jest.spyOn(m.User.prototype, 'comparePassword');
    try {
      const results = await Promise.all(Array.from({ length: BURST }, () =>
        call('POST', '/auth/login', { body: { identifier: 'pat@example.com', password: 'wrong-Passw0rd!' } })));
      const statuses = results.map((r) => r.status);

      expect(compare).toHaveBeenCalledTimes(3);
      expect(statuses.filter((s) => s === 401)).toHaveLength(3);
      expect(statuses.filter((s) => s === 429)).toHaveLength(BURST - 3);

      // The run locked: even the RIGHT password is now refused without a compare.
      compare.mockClear();
      const right = await call('POST', '/auth/login', { body: { identifier: 'pat@example.com', password: PASSWORD } });
      expect(right.status).toBe(429);
      expect(compare).not.toHaveBeenCalled();
    } finally {
      compare.mockRestore();
    }
  });
});
