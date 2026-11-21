// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The stored credit-ledger compaction against a REAL MongoDB: the write is a
 * compare-and-set on the whole `creditLedger` array, so it must match exactly
 * the array it read (BSON equality — field order, Dates) and miss when any
 * concurrent `$push` or in-place tombstone changed it meanwhile.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped locally, REQUIRED on CI).
 */

import { jest, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { integrationSuite, MONGOD_VERSION } from './helpers/integration-gate.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: () => undefined }));

const suite = integrationSuite();

suite('Stored credit-ledger compaction (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, Subscription: any, compaction: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    await mongoose.connect(mongod.getUri());
    ({ Subscription } = await import('../src/models/subscription.js'));
    compaction = await import('../src/helpers/credit-ledger-compaction.js');
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    await Subscription.collection.deleteMany({});
  });

  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
    discountId: 'promo:p1', cents: 100, appliedAt: new Date(Date.UTC(2026, 0, i + 1)), dedupeKey: `promo:p1:org-1:2026-${String(i + 1).padStart(2, '0')}`, campaign: 'spring',
  }));
  const seed = async (n: number) => {
    const { insertedId } = await Subscription.collection.insertOne({ orgId: 'org-1', creditLedger: rows(n), creditBalanceCents: 0 });
    return insertedId;
  };
  const ledgerOf = async (id: unknown) => (await Subscription.collection.findOne({ _id: id })).creditLedger;

  it('folds a ledger that the grant paths wrote, matching it exactly', async () => {
    const id = await seed(15);
    // A row the model's own $push wrote (Mongoose casting, schema field order).
    await Subscription.updateOne({ _id: id }, { $push: { creditLedger: { discountId: 'combo:c', cents: 50, appliedAt: new Date(), dedupeKey: '2026-16' } } });

    await expect(compaction.compactStoredCreditLedger(Subscription.collection, id)).resolves.toBe(true);
    const ledger = await ledgerOf(id);
    expect(ledger).toHaveLength(compaction.DEFAULT_KEEP_RECENT + 2);
    expect(ledger.find((r: any) => r.dedupeKey === 'compacted:promo:p1')).toMatchObject({ cents: 300, grantCount: 3 });
  });

  it('misses — and writes nothing — when the ledger changed between the read and the write', async () => {
    const id = await seed(15);
    const real = Subscription.collection;
    const racing = {
      findOne: async (...a: unknown[]) => {
        const snapshot = await real.findOne(...a);
        // A clawback tombstones a row in place: the length is unchanged, the array is not.
        await Subscription.updateOne({ '_id': id, 'creditLedger.dedupeKey': 'promo:p1:org-1:2026-01' }, { $set: { 'creditLedger.$.clawedBackAt': new Date() } });
        return snapshot;
      },
      updateOne: (...a: unknown[]) => real.updateOne(...a),
    };
    await expect(compaction.compactStoredCreditLedger(racing, id)).resolves.toBe(false);
    const ledger = await ledgerOf(id);
    expect(ledger).toHaveLength(15);
    expect(ledger[0].clawedBackAt).toBeInstanceOf(Date);
  });
});
