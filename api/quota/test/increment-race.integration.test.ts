// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Quota increments racing each other against a REAL MongoDB (mongodb-memory-server).
 *
 * The whole correctness argument for `incrementUsage` / `incrementMetered` is that
 * the limit check, the period reset and the `$inc` happen in ONE conditional
 * pipeline update driven by the server's `$$NOW` — so however many replicas race,
 * the counter cannot pass the cap and a period rollover cannot lose increments.
 * A mock can only check the update document that was BUILT; this suite fires
 * genuinely concurrent increments at a real mongod and reads back the counter.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped locally, REQUIRED on CI).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite, MONGOD_VERSION } from './helpers/integration-gate.js';

const suite = integrationSuite();

suite('quota increment races (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, Organization: any, quotaService: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    // The service's config reads the URI at import, so set it before loading it.
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(mongod.getUri());
    ({ Organization } = await import('../src/models/organization.js'));
    await Organization.init();
    ({ quotaService } = await import('../src/services/quota-service.js'));
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    await Organization.deleteMany({});
  });

  const DAY = 24 * 3600_000;

  /** A flat (no parent, no children) org with explicit limits and optional usage. */
  async function seedOrg(quotas: Record<string, number>, usage: Record<string, { used: number; resetAt: Date }> = {}): Promise<string> {
    const id = new mongoose.Types.ObjectId();
    await Organization.collection.insertOne({
      _id: id, name: `org-${id}`, slug: `org-${id}`, tier: 'pro', parentOrgId: null, quotas, usage,
    });
    return id.toHexString();
  }

  const usedOf = async (orgId: string, type: string): Promise<number> => {
    const doc = await Organization.collection.findOne({ _id: new mongoose.Types.ObjectId(orgId) });
    return doc?.usage?.[type]?.used ?? 0;
  };

  it('25 concurrent reservations against a cap of 10 admit exactly 10', async () => {
    const orgId = await seedOrg({ pipelines: 10 }, { pipelines: { used: 0, resetAt: new Date(Date.now() + 30 * DAY) } });
    const results = await Promise.all(Array.from({ length: 25 }, () => quotaService.incrementUsage(orgId, 'pipelines', 1)));
    expect(results.filter((r: { exceeded: boolean }) => !r.exceeded)).toHaveLength(10);
    expect(await usedOf(orgId, 'pipelines')).toBe(10);
  });

  it('a race that starts on an EXPIRED period resets once and loses no increment', async () => {
    // 9 of 10 used last period; the period is over, so everything racing in now
    // lands in a fresh one. A non-atomic read-reset-write would let concurrent
    // callers each reset the counter and overwrite one another's increments.
    const orgId = await seedOrg({ pipelines: 10 }, { pipelines: { used: 9, resetAt: new Date(Date.now() - DAY) } });
    const results = await Promise.all(Array.from({ length: 6 }, () => quotaService.incrementUsage(orgId, 'pipelines', 1)));
    expect(results.every((r: { exceeded: boolean }) => !r.exceeded)).toBe(true);
    expect(await usedOf(orgId, 'pipelines')).toBe(6);
    const doc = await Organization.collection.findOne({ _id: new mongoose.Types.ObjectId(orgId) });
    expect(doc.usage.pipelines.resetAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('an unlimited (-1) quota counts every concurrent increment', async () => {
    const orgId = await seedOrg({ pipelines: -1 }, { pipelines: { used: 0, resetAt: new Date(Date.now() + 30 * DAY) } });
    await Promise.all(Array.from({ length: 40 }, () => quotaService.incrementUsage(orgId, 'pipelines', 1)));
    expect(await usedOf(orgId, 'pipelines')).toBe(40);
  });

  it('concurrent METERED flushes never push the counter past the enforced cap, and account for every unit', async () => {
    const orgId = await seedOrg({ apiCalls: 100 }, { apiCalls: { used: 0, resetAt: new Date(Date.now() + 30 * DAY) } });
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => quotaService.incrementMetered(orgId, 'apiCalls', 15)));
    const counted = outcomes.reduce((s: number, o: { counted: number }) => s + o.counted, 0);
    const overshoot = outcomes.reduce((s: number, o: { overshoot: number }) => s + o.overshoot, 0);
    const used = await usedOf(orgId, 'apiCalls');
    // Every served unit is either counted or recorded as overshoot — none vanish.
    expect(counted + overshoot).toBe(150);
    // The counter is exactly what was counted (no lost $inc), and bounded by the
    // enforced cap (the limit plus apiCalls' soft band, never unbounded).
    expect(used).toBe(counted);
    expect(used).toBeGreaterThanOrEqual(100);
    expect(used).toBeLessThan(150);
  });
});
