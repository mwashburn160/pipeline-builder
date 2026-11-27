// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `metadata` is a Mixed path that several writers share CONCURRENTLY — the
 * provider add-on resync marker (`providerAddonSyncPending`, which is what
 * stops a removed bundle being billed forever), the discount apply claim, the
 * Marketplace drawdown hour, the stale-period key — each written with its own
 * atomic dot-path `$set`/`$unset`. A handler that loaded the document and then
 * REPLACED the whole object (`subscription.metadata = { ...rest }`) wrote every
 * key it had read back on save, erasing any marker another writer set in
 * between. These run the real handlers' metadata step against a real mongod.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped locally, REQUIRED on CI).
 */

import { jest, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { integrationSuite, MONGOD_VERSION } from './helpers/integration-gate.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
}));
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  recordReactivatePlanMissing: async () => undefined,
  createBillingEvent: async () => undefined,
}));
jest.unstable_mockModule('../src/helpers/promotion-engine.js', () => ({ clawbackRecentPromotions: async () => 0 }));
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({ getPaymentProvider: () => ({}) }));
jest.unstable_mockModule('../src/helpers/entitlement-sync.js', () => ({ syncEntitlements: async () => true }));

const suite = integrationSuite();

suite('Subscription metadata writes are path-scoped (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, Subscription: any, prepareLapseReconcile: any, providerReconcile: any, setMetadataKey: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    await mongoose.connect(mongod.getUri());
    ({ Subscription } = await import('../src/models/subscription.js'));
    await Subscription.init();
    ({ prepareLapseReconcile } = await import('../src/helpers/lapse-reconcile.js'));
    providerReconcile = await import('../src/helpers/provider-reconcile.js');
    ({ setMetadataKey } = await import('../src/helpers/subscription-metadata.js'));
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => { await Subscription.deleteMany({}); });

  const seed = (metadata: Record<string, unknown>) => Subscription.create({
    orgId: 'org-1',
    planId: 'pro',
    status: 'active',
    interval: 'monthly',
    currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
    metadata,
  });

  it('clearing the grace-lapse marker keeps a provider-resync marker set concurrently', async () => {
    const { _id } = await seed({ gracePeriodDowngradedAt: new Date('2026-11-10T00:00:00Z') });
    const doc = await Subscription.findById(_id);
    expect(prepareLapseReconcile(doc, 'test')).not.toBeNull();
    // Another writer marks a failed provider add-on sync between our read and our save.
    await Subscription.updateOne({ _id }, { $set: { 'metadata.providerAddonSyncPending': true } });
    await doc.save();

    const row = await Subscription.findById(_id).lean();
    expect(row.metadata.gracePeriodDowngradedAt).toBeUndefined();
    expect(row.metadata.providerAddonSyncPending).toBe(true);
  });

  it('stamping and clearing the provider-reconcile marker keep a concurrent drawdown-hour claim', async () => {
    const { _id } = await seed({});
    const doc = await Subscription.findById(_id);
    await Subscription.updateOne({ _id }, { $set: { 'metadata.lastDrawdownHour': '2026-11-27T14' } });
    await providerReconcile.markProviderReconcilePending(doc, 'cancel', true, new Error('timeout'));
    let row = await Subscription.findById(_id).lean();
    expect(row.metadata.lastDrawdownHour).toBe('2026-11-27T14');
    expect(row.metadata.providerReconcilePending).toBeDefined();

    await Subscription.updateOne({ _id }, { $set: { 'metadata.providerAddonSyncPending': true } });
    await providerReconcile.clearProviderReconcilePending(doc);
    row = await Subscription.findById(_id).lean();
    expect(row.metadata.providerReconcilePending).toBeUndefined();
    expect(row.metadata).toMatchObject({ lastDrawdownHour: '2026-11-27T14', providerAddonSyncPending: true });
  });

  it('setMetadataKey on a plain object sets and removes one key, leaving the rest', () => {
    const plain: { metadata?: Record<string, unknown> } = { metadata: { a: 1, b: 2 } };
    setMetadataKey(plain, 'b', undefined);
    setMetadataKey(plain, 'c', 3);
    expect(plain.metadata).toEqual({ a: 1, c: 3 });
  });
});
