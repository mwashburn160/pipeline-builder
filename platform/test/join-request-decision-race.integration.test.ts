// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo (replica set — approval is transactional) test for deciding a
 * domain join request when two admins answer it at once.
 *
 * The decision used to be read-check-save: both an approve and a deny read
 * `status: 'pending'`, both passed, and both wrote — the requester was given a
 * membership AND told they were denied (or the last writer silently flipped the
 * recorded outcome). The decision is now a conditional update on
 * `status: 'pending'`, inside the approval's membership transaction, so exactly
 * one wins and the other is answered 409 `JOIN_ALREADY_DECIDED`.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default).
 */

import { jest, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

// The decision e-mail is fire-and-forget and irrelevant here.
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ recordAuditEvent: () => undefined, audit: () => undefined }));

suite('join request decision race (real Mongo replica set)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, svc: any, errors: any, roles: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    for (const model of [m.User, m.UserOrganization, m.Role, m.RoleAssignment, m.JoinRequest, m.Organization, m.Invitation]) {
      await model.createCollection().catch(() => undefined);
    }
    ({ orgDomainService: svc } = await import('../src/services/org-domain-service.js'));
    errors = await import('../src/services/org-domain-errors.js');
    roles = await import('../src/services/roles-service.js');
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  let orgId: string;
  let requesterId: unknown;
  let requestId: string;
  const decider = () => String(new mongoose.Types.ObjectId());

  beforeEach(async () => {
    for (const model of [m.User, m.UserOrganization, m.Role, m.RoleAssignment, m.JoinRequest, m.Organization]) await model.deleteMany({});
    const owner = await m.User.create({ username: 'owner', email: 'owner@acme.com', isEmailVerified: true });
    const org = await m.Organization.create({ name: 'Acme', owner: owner._id, quotas: { seats: -1 } });
    orgId = String(org._id);
    await m.UserOrganization.create({ userId: owner._id, organizationId: org._id, role: 'owner' });
    await roles.seedDefaultRoles(orgId, owner._id);
    const requester = await m.User.create({ username: 'pat', email: 'pat@acme.com', isEmailVerified: true });
    requesterId = requester._id;
    requestId = String((await m.JoinRequest.create({ organizationId: orgId, userId: requester._id, email: 'pat@acme.com' }))._id);
    // Eligibility is re-checked at approval; the domain machinery is not under test.
    svc.findDiscoverableOrgsByEmail = async () => [{ orgId }];
  });

  it('concurrent APPROVE and DENY: exactly one wins, the loser gets JOIN_ALREADY_DECIDED, and the outcome is consistent', async () => {
    const results = await Promise.allSettled([
      svc.decideJoinRequest(orgId, requestId, 'approve', decider()),
      svc.decideJoinRequest(orgId, requestId, 'deny', decider()),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled') as Array<PromiseFulfilledResult<{ status: string }>>;
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason.message).toBe('JOIN_ALREADY_DECIDED');
    expect(errors.DOMAIN_ERROR_MAP[errors.JOIN_ALREADY_DECIDED].status).toBe(409);

    const stored = await m.JoinRequest.findById(requestId).lean();
    const membership = await m.UserOrganization.findOne({ userId: requesterId, organizationId: orgId, isActive: true }).lean();
    expect(stored.status).toBe(won[0].value.status);
    // Never "denied" while holding the membership, never "approved" without one.
    if (stored.status === 'approved') expect(membership).not.toBeNull();
    else expect(membership).toBeNull();
  });

  it('a second decision on an already-decided request is a 409, and changes nothing', async () => {
    await svc.decideJoinRequest(orgId, requestId, 'deny', decider());
    await expect(svc.decideJoinRequest(orgId, requestId, 'approve', decider())).rejects.toThrow('JOIN_ALREADY_DECIDED');
    expect((await m.JoinRequest.findById(requestId).lean()).status).toBe('denied');
    expect(await m.UserOrganization.exists({ userId: requesterId, organizationId: orgId })).toBeNull();
  });
});
