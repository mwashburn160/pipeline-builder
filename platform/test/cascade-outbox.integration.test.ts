// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The cascade outbox against a REAL Mongo replica set (the enqueue is
 * transactional, so it needs one):
 *
 *  - the org purge's hard delete and its outbox legs commit ATOMICALLY: the org
 *    gone ⇔ every downstream leg pending; a transaction that fails after the
 *    enqueue leaves the org AND no legs;
 *  - a crash between the commit and the first dispatch loses nothing: a fresh
 *    dispatcher (a "restarted" process — a new pass over the same collection)
 *    delivers every leg;
 *  - a user deletion writes its erasure leg in the same transaction, and a
 *    refused deletion writes none;
 *  - the unique (kind, subjectId, service) index makes a re-enqueue a no-op;
 *  - backoff and dead-lettering persist across passes;
 *  - the operator listing filters and pages, and a redrive puts a dead leg back
 *    in the queue (and refuses a delivered one), after which it delivers.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default) — mirrors
 * user-cascade.integration.test.ts. The downstream HTTP is stood in for by the
 * legs module (its real wiring is cascade-legs.test.ts), and the org cascade's
 * platform-own teardown (which needs Postgres) by a clean report.
 */

import { jest, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

// Stand-in downstream services: per-service answers a test can flip.
const answers = new Map<string, { ok: boolean; statusCode?: number; error?: string }>();
const delivered: string[] = [];
const LEGS = ['pipeline', 'plugin', 'compliance', 'message', 'reporting', 'quota', 'billing', 'message-blobs', 'image-registry']
  .map((service) => ({ kind: 'org.deleted', service }))
  .concat([{ kind: 'user.erased', service: 'plugin' }])
  .map((l) => ({
    ...l,
    deliver: async (subjectId: string) => {
      delivered.push(`${l.kind}/${l.service}/${subjectId}`);
      return answers.get(l.service) ?? { ok: true, statusCode: 200 };
    },
  }));
jest.unstable_mockModule('../src/services/cascade-legs.js', () => ({
  CASCADE_LEGS: LEGS,
  legsFor: (kind: string) => LEGS.filter((l) => l.kind === kind),
  findLeg: (kind: string, service: string) => LEGS.find((l) => l.kind === kind && l.service === service),
}));
// Platform's own teardown reads Postgres; this suite has none (org-cascade-service.test.ts covers it).
jest.unstable_mockModule('../src/services/org-cascade-service.js', () => ({
  cascadeDeleteOrg: async () => ({ postgres: {}, mongo: {}, mongoFailures: [], auditArchive: { ok: true, archived: 0 } }),
  softDeleteOrg: async () => { throw new Error('not used'); },
}));

suite('cascade outbox (real Mongo replica set)', () => {
  let replSet: { getUri: () => string; stop: () => Promise<boolean> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mongoose: any, m: any, outbox: any, purgeExpiredOrgs: any, organizationService: any, userAdminService: any;

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    replSet = await MongoMemoryReplSet.create({ binary: { version: MONGOD_VERSION }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = replSet.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    // The purge sweep meters its outcomes; give it a registry to meter into.
    const { Registry } = await import('prom-client');
    const { setMetricsRegistry } = await import('../src/observability/metrics.js');
    setMetricsRegistry(new Registry());
    m = await import('../src/models/index.js');
    for (const model of [m.Organization, m.User, m.UserOrganization, m.Role, m.RoleAssignment, m.CascadeOutbox, m.PersonalAccessToken, m.JoinRequest, m.UserPreferences, m.WebAuthnCredential]) {
      await model.createCollection().catch(() => undefined);
    }
    // The unique leg index must be live for the idempotency test.
    await m.CascadeOutbox.createIndexes();
    outbox = await import('../src/services/cascade-outbox.js');
    ({ purgeExpiredOrgs } = await import('../src/services/org-purge.js'));
    ({ organizationService } = await import('../src/services/organization-service.js'));
    ({ userAdminService } = await import('../src/services/user-admin-service.js'));
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  beforeEach(async () => {
    for (const model of [m.Organization, m.User, m.UserOrganization, m.Role, m.RoleAssignment, m.CascadeOutbox]) await model.deleteMany({});
    answers.clear();
    delivered.length = 0;
  });

  /** A soft-deleted org whose retention window has lapsed — due for purge. */
  async function expiredOrg(name = 'Acme'): Promise<string> {
    const org = await m.Organization.create({
      name,
      owner: new mongoose.Types.ObjectId(),
      deletedAt: new Date(Date.now() - 40 * 86_400_000),
      purgeAfter: new Date(Date.now() - 1000),
    });
    return String(org._id);
  }

  const legsOf = (subjectId: string) => m.CascadeOutbox.find({ subjectId }).sort({ service: 1 }).lean();

  it('writes every downstream leg ATOMICALLY with the purge\'s hard delete', async () => {
    const orgId = await expiredOrg();

    const res = await purgeExpiredOrgs();

    expect(res).toMatchObject({ purged: 1, deferred: 0, failed: 0 });
    expect(await m.Organization.exists({ _id: orgId })).toBeNull();
    const legs = await legsOf(orgId);
    expect(legs.map((l: { service: string }) => l.service)).toEqual(
      ['billing', 'compliance', 'image-registry', 'message', 'message-blobs', 'pipeline', 'plugin', 'quota', 'reporting'],
    );
    expect(legs.every((l: { status: string; kind: string; attempts: number }) => l.status === 'pending' && l.kind === 'org.deleted' && l.attempts === 0)).toBe(true);
    // The purge itself delivers nothing — the dispatcher does.
    expect(delivered).toEqual([]);
  });

  it('a transaction that fails after the enqueue leaves the org AND no legs', async () => {
    const orgId = await expiredOrg();

    await expect(organizationService.delete(orgId, {
      withinTx: async (session: unknown) => {
        await outbox.enqueueCascade('org.deleted', orgId, session);
        throw new Error('crash before commit');
      },
    })).rejects.toThrow('crash before commit');

    expect(await m.Organization.exists({ _id: orgId })).not.toBeNull();
    expect(await m.CascadeOutbox.countDocuments({ subjectId: orgId })).toBe(0);
  });

  it('a crash between the commit and the first dispatch still delivers every leg', async () => {
    const orgId = await expiredOrg();
    await purgeExpiredOrgs();
    // "Crash": the process that purged never dispatched. A new process's
    // dispatcher sees only what is in Mongo.
    const res = await outbox.dispatchCascadeOutbox();

    expect(res).toMatchObject({ scanned: 9, delivered: 9, retried: 0, dead: 0 });
    expect(delivered.filter((d) => d.endsWith(`/${orgId}`))).toHaveLength(9);
    const legs = await legsOf(orgId);
    expect(legs.every((l: { status: string; completedAt: Date | null }) => l.status === 'done' && l.completedAt instanceof Date)).toBe(true);
    // Nothing left to do on the next pass.
    expect((await outbox.dispatchCascadeOutbox()).scanned).toBe(0);
  });

  it('re-enqueueing the same cascade is a no-op (the unique leg index)', async () => {
    const orgId = await expiredOrg();
    await purgeExpiredOrgs();
    await outbox.dispatchCascadeOutbox();

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => outbox.enqueueCascade('org.deleted', orgId, session));
    } finally {
      await session.endSession();
    }

    const legs = await legsOf(orgId);
    expect(legs).toHaveLength(9);
    expect(legs.every((l: { status: string }) => l.status === 'done')).toBe(true);
  });

  it('persists backoff across passes and dead-letters at the ceiling', async () => {
    const orgId = await expiredOrg();
    await purgeExpiredOrgs();
    answers.set('billing', { ok: false, statusCode: 503, error: 'HTTP 503' });

    let clock = Date.now();
    const now = () => new Date(clock);
    const opts = { now, maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 60_000, leaseMs: 10_000 };

    await outbox.dispatchCascadeOutbox(undefined, opts);
    let billing = await m.CascadeOutbox.findOne({ subjectId: orgId, service: 'billing' }).lean();
    expect(billing).toMatchObject({ status: 'pending', attempts: 1, lastError: 'HTTP 503', lastStatusCode: 503 });
    expect(billing.nextAttemptAt.getTime()).toBe(clock + 1000);

    clock += 1000;
    await outbox.dispatchCascadeOutbox(undefined, opts);
    clock += 2000;
    await outbox.dispatchCascadeOutbox(undefined, opts);

    billing = await m.CascadeOutbox.findOne({ subjectId: orgId, service: 'billing' }).lean();
    expect(billing).toMatchObject({ status: 'dead', attempts: 3 });
    const status = await outbox.cascadeStatus(orgId, 'org.deleted');
    expect(status.filter((s: { status: string }) => s.status === 'dead').map((s: { service: string }) => s.service)).toEqual(['billing']);
    expect(status.filter((s: { status: string }) => s.status === 'done')).toHaveLength(8);
  });

  it('lists legs by filter, pages them, and redrives a dead leg to delivery', async () => {
    const orgId = await expiredOrg();
    await purgeExpiredOrgs();
    answers.set('billing', { ok: false, statusCode: 503, error: 'HTTP 503' });
    const opts = { maxAttempts: 1 };
    await outbox.dispatchCascadeOutbox(undefined, opts);

    const dead = await outbox.listCascadeLegs({ status: 'dead' }, { limit: 50, offset: 0 });
    expect(dead.total).toBe(1);
    expect(dead.legs[0]).toMatchObject({ subjectId: orgId, kind: 'org.deleted', service: 'billing', status: 'dead', attempts: 1, lastStatusCode: 503 });
    expect((await outbox.listCascadeLegs({ subjectId: orgId, kind: 'org.deleted' }, { limit: 50, offset: 0 })).total).toBe(9);
    expect((await outbox.listCascadeLegs({ service: 'billing', status: 'done' }, { limit: 50, offset: 0 })).total).toBe(0);
    const page = await outbox.listCascadeLegs({ subjectId: orgId }, { limit: 4, offset: 8 });
    expect(page).toMatchObject({ total: 9 });
    expect(page.legs).toHaveLength(1);

    // A delivered leg is refused; an unknown or malformed id is not found.
    const doneLeg = (await outbox.listCascadeLegs({ service: 'pipeline' }, { limit: 1, offset: 0 })).legs[0];
    expect(await outbox.redriveCascadeLeg(doneLeg.id)).toEqual({ ok: false, reason: 'already_done' });
    expect(await outbox.redriveCascadeLeg(String(new mongoose.Types.ObjectId()))).toEqual({ ok: false, reason: 'not_found' });
    expect(await outbox.redriveCascadeLeg('not-an-id')).toEqual({ ok: false, reason: 'not_found' });

    answers.delete('billing');
    const redriven = await outbox.redriveCascadeLeg(dead.legs[0].id);
    expect(redriven).toMatchObject({ ok: true, previous: { status: 'dead', attempts: 1 }, leg: { status: 'pending', attempts: 0, completedAt: null } });
    const row = await m.CascadeOutbox.findById(dead.legs[0].id).lean();
    expect(row).toMatchObject({ status: 'pending', attempts: 0, completedAt: null, lastStatusCode: 503 });

    const res = await outbox.dispatchCascadeOutbox(undefined, opts);
    expect(res).toMatchObject({ scanned: 1, delivered: 1 });
    expect(await m.CascadeOutbox.findById(dead.legs[0].id).lean()).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('redrive with resetAttempts=false keeps the count, so a dead leg gets exactly one more try', async () => {
    const orgId = await expiredOrg();
    await purgeExpiredOrgs();
    answers.set('quota', { ok: false, statusCode: 500, error: 'HTTP 500' });
    await outbox.dispatchCascadeOutbox(undefined, { maxAttempts: 2 });
    // Make the retry due now rather than after its backoff.
    await m.CascadeOutbox.updateOne({ subjectId: orgId, service: 'quota' }, { $set: { nextAttemptAt: new Date() } });
    await outbox.dispatchCascadeOutbox(undefined, { maxAttempts: 2 });
    const leg = await m.CascadeOutbox.findOne({ subjectId: orgId, service: 'quota' }).lean();
    expect(leg).toMatchObject({ status: 'dead', attempts: 2 });

    const redriven = await outbox.redriveCascadeLeg(String(leg._id), { resetAttempts: false });
    expect(redriven).toMatchObject({ ok: true, leg: { status: 'pending', attempts: 2 } });
    await outbox.dispatchCascadeOutbox(undefined, { maxAttempts: 2 });
    expect(await m.CascadeOutbox.findById(leg._id).lean()).toMatchObject({ status: 'dead', attempts: 3 });
  });

  it('a user deletion writes its erasure leg in the same transaction; a refused one writes none', async () => {
    const orgId = await expiredOrg('Live');
    await m.Organization.updateOne({ _id: orgId }, { $set: { deletedAt: null, purgeAfter: null } });
    const leaver = await m.User.create({ username: 'leaver', email: 'leaver@acme.com', isEmailVerified: true });
    const owner = await m.User.create({ username: 'owner', email: 'owner@acme.com', isEmailVerified: true });
    const colleague = await m.User.create({ username: 'colleague', email: 'colleague@acme.com', isEmailVerified: true });
    await m.UserOrganization.create({ userId: owner._id, organizationId: orgId, role: 'owner' });
    await m.UserOrganization.create({ userId: colleague._id, organizationId: orgId, role: 'member', isActive: false });

    await userAdminService.deleteUserById(String(leaver._id));
    expect(await legsOf(String(leaver._id))).toEqual([
      expect.objectContaining({ kind: 'user.erased', service: 'plugin', status: 'pending' }),
    ]);

    // An org owner with other members is refused — the transaction rolls back,
    // and with it the erasure marker.
    await expect(userAdminService.deleteUserById(String(owner._id))).rejects.toThrow('USER_OWNER_HAS_ORGS');
    expect(await m.CascadeOutbox.countDocuments({ subjectId: String(owner._id) })).toBe(0);

    await outbox.dispatchCascadeOutbox();
    expect(delivered).toContain(`user.erased/plugin/${String(leaver._id)}`);
  });
});
