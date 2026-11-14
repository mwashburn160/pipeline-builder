// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for the per-user data export (`GET /user/export`):
 * everything about the person is in it, and no credential is.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped by default).
 */

import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('user data export (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, exportUserData: any, apiKeyService: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    ({ exportUserData } = await import('../src/services/user-export.js'));
    ({ apiKeyService } = await import('../src/services/api-key-service.js'));
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  it('bundles the account, memberships, keys and audit trail — and no secret', async () => {
    const org = await m.Organization.create({ name: 'Acme', owner: new mongoose.Types.ObjectId() });
    const user = await m.User.create({
      username: 'person',
      email: 'person@acme.com',
      password: 'Passw0rd!secret',
      isEmailVerified: true,
      lastActiveOrgId: org._id,
      emailVerificationToken: 'tok-hash-xyz',
    });
    const uid = String(user._id);
    await m.UserOrganization.create({ userId: user._id, organizationId: org._id, role: 'admin', isActive: true });
    const { key } = await apiKeyService.create(uid, { name: 'ci', expiresInSeconds: 86400, client: {} },
      { amr: ['pwd'], aal: 1, authTime: new Date() });
    await m.AuditEvent.collection.insertOne({ action: 'user.login', actorId: uid, orgId: String(org._id), affectedOrgId: String(org._id), seq: 1, outcome: 'success', createdAt: new Date() });
    await m.AuditEvent.collection.insertOne({ action: 'admin.user.update', actorId: 'someone-else', targetId: uid, orgId: String(org._id), affectedOrgId: String(org._id), seq: 2, outcome: 'success', createdAt: new Date() });

    const out = await exportUserData(uid);
    expect(out.account).toMatchObject({ username: 'person', email: 'person@acme.com' });
    expect(out.memberships).toEqual([expect.objectContaining({ organizationId: String(org._id), organizationName: 'Acme', role: 'admin' })]);
    expect(out.accessKeys).toEqual([expect.objectContaining({ name: 'ci' })]);
    expect(out.auditEvents.map((e: { action: string }) => e.action).sort()).toEqual(['admin.user.update', 'user.login']);
    expect(out.truncated).toBeUndefined();

    const text = JSON.stringify(out);
    expect(text).not.toContain(key);
    expect(text).not.toContain('tok-hash-xyz');
    expect(text).not.toMatch(/"password"|"keyHash"|"tokenVersion"|"refreshSessions"/);
  });

  it('refuses an unknown account', async () => {
    await expect(exportUserData(String(new mongoose.Types.ObjectId()))).rejects.toThrow('PROFILE_USER_NOT_FOUND');
  });
});
