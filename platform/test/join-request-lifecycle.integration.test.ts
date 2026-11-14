// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for the domain-join request lifecycle around a decision:
 *   - an admin can clear a DENIED request (and only a denied one) so the
 *     person may ask again — a denial used to be permanent;
 *   - the requester can withdraw their own PENDING request;
 *   - a pending request nobody answers for 30 days lapses (audited);
 *   - the admin list pages.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped by default).
 */

import { jest, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

const audited: Array<{ action: string; affectedOrgId?: string }> = [];
jest.unstable_mockModule('../src/helpers/audit.js', () => ({
  recordAuditEvent: (e: { action: string; affectedOrgId?: string }) => { audited.push(e); },
  audit: () => undefined,
}));

suite('join request lifecycle (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, svc: any, mod: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  let orgId: string;
  let userId: any;

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    mod = await import('../src/services/org-domain-service.js');
    svc = mod.orgDomainService;
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    await m.JoinRequest.deleteMany({});
    audited.length = 0;
    orgId = String(new mongoose.Types.ObjectId());
    userId = new mongoose.Types.ObjectId();
  });

  const file = (status: string, extra: Record<string, unknown> = {}) =>
    m.JoinRequest.create({ organizationId: orgId, userId, email: 'p@acme.com', status, ...extra });

  it('an admin clears a DENIED request, and nothing else', async () => {
    const pending = await file('pending');
    await expect(svc.resetDeniedJoinRequest(orgId, String(pending._id))).rejects.toThrow('JOIN_REQUEST_NOT_FOUND');
    await m.JoinRequest.updateOne({ _id: pending._id }, { $set: { status: 'denied' } });
    // Another org's admin can't clear it.
    await expect(svc.resetDeniedJoinRequest(String(new mongoose.Types.ObjectId()), String(pending._id))).rejects.toThrow('JOIN_REQUEST_NOT_FOUND');
    expect(await svc.resetDeniedJoinRequest(orgId, String(pending._id))).toEqual({ userId: String(userId) });
    expect(await m.JoinRequest.countDocuments({})).toBe(0);
  });

  it('the requester withdraws their own pending request only', async () => {
    await file('denied');
    await expect(svc.withdrawJoinRequest(userId, orgId)).rejects.toThrow('JOIN_REQUEST_NOT_FOUND');
    await m.JoinRequest.updateOne({}, { $set: { status: 'pending' } });
    await expect(svc.withdrawJoinRequest(new mongoose.Types.ObjectId(), orgId)).rejects.toThrow('JOIN_REQUEST_NOT_FOUND');
    await svc.withdrawJoinRequest(userId, orgId);
    expect(await m.JoinRequest.countDocuments({})).toBe(0);
  });

  it('a pending request unanswered for 30 days lapses and is audited; a fresh one and a denial stay', async () => {
    const old = new Date(Date.now() - mod.JOIN_REQUEST_PENDING_TTL_MS - 60_000);
    await m.JoinRequest.collection.insertOne({ organizationId: new mongoose.Types.ObjectId(orgId), userId, email: 'old@acme.com', status: 'pending', createdAt: old, updatedAt: old });
    await m.JoinRequest.collection.insertOne({ organizationId: new mongoose.Types.ObjectId(orgId), userId: new mongoose.Types.ObjectId(), email: 'no@acme.com', status: 'denied', createdAt: old, updatedAt: old });
    await m.JoinRequest.create({ organizationId: orgId, userId: new mongoose.Types.ObjectId(), email: 'new@acme.com', status: 'pending' });

    expect(await svc.expireStaleJoinRequests()).toBe(1);
    expect((await m.JoinRequest.find({}).lean()).map((r: { email: string }) => r.email).sort()).toEqual(['new@acme.com', 'no@acme.com']);
    expect(audited).toEqual([expect.objectContaining({ action: 'org.join.expire', affectedOrgId: orgId })]);
  });

  it('pages the admin list', async () => {
    for (let i = 0; i < 3; i += 1) {
      await m.JoinRequest.create({ organizationId: orgId, userId: new mongoose.Types.ObjectId(), email: `u${i}@acme.com`, status: 'pending' });
    }
    const first = await svc.listJoinRequests(orgId, 'pending', { limit: 2, offset: 0 });
    expect(first.requests).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await svc.listJoinRequests(orgId, 'pending', { limit: 2, offset: 2 });
    expect(second.requests).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });
});
