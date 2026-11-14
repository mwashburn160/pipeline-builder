// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for the chunked deleted-org snapshot store.
 *
 * The bug it guards: the snapshot used to be ONE document, so an export over
 * Mongo's 16 MB BSON limit threw on insert and the org could never be
 * soft-deleted. Only a real server enforces that limit, so this writes a
 * >16 MB fixture and reads it back byte-for-byte.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped by default).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('deleted-org snapshot store (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, store: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const ORG = '64b000000000000000000001';

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    await Promise.all([m.DeletedOrgSnapshot.init(), m.DeletedOrgSnapshotChunk.init(), m.ArchivedAuditEvent.init()]);
    store = await import('../src/services/deleted-org-snapshot-store.js');
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    await m.DeletedOrgSnapshot.deleteMany({});
    await m.DeletedOrgSnapshotChunk.deleteMany({});
  });

  const input = (snapshot: unknown) => ({
    organizationId: ORG,
    name: 'Acme',
    snapshot,
    deletedAt: new Date(),
    deletedBy: 'admin-1',
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  });

  it('stores and reassembles an export larger than the 16 MB document limit', async () => {
    // ~20 MB of audit-shaped rows.
    const rows = Array.from({ length: 50_000 }, (_, i) => ({ _id: `evt-${i}`, action: 'user.login', details: 'x'.repeat(400) }));
    const snapshot = { orgId: ORG, mongo: { auditEvents: rows } };
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(16 * 1024 * 1024);

    const id = await store.storeDeletedOrgSnapshot(input(snapshot));
    const header = await m.DeletedOrgSnapshot.findById(id).lean();
    expect(header.chunkCount).toBeGreaterThan(2);
    expect(await m.DeletedOrgSnapshotChunk.countDocuments({ snapshotId: header._id })).toBe(header.chunkCount);

    const read = await store.readDeletedOrgSnapshot(id);
    expect(read.snapshot).toEqual(snapshot);
    expect(await store.latestSnapshotIdForOrg(ORG)).toBe(id);
  }, 120_000);

  it('detects a missing or altered chunk', async () => {
    const id = await store.storeDeletedOrgSnapshot(input({ a: 'x'.repeat(5000) }), 1024);
    const oid = new mongoose.Types.ObjectId(id);
    await m.DeletedOrgSnapshotChunk.updateOne({ snapshotId: oid, seq: 1 }, { $set: { data: Buffer.from('tampered') } });
    await expect(store.readDeletedOrgSnapshot(id)).rejects.toThrow(store.SNAPSHOT_CORRUPT);
    await m.DeletedOrgSnapshotChunk.deleteOne({ snapshotId: oid, seq: 2 });
    await expect(store.readDeletedOrgSnapshot(id)).rejects.toThrow(store.SNAPSHOT_CORRUPT);
  });

  it('returns null for an unknown or malformed id', async () => {
    expect(await store.readDeletedOrgSnapshot('nope')).toBeNull();
    expect(await store.readDeletedOrgSnapshot(String(new mongoose.Types.ObjectId()))).toBeNull();
  });

  it('enforces retention with TTL indexes on the header, every chunk and the audit archive', async () => {
    const ttl = async (model: any) => (await model.collection.indexes())
      .find((i: { key: Record<string, number> }) => i.key.expiresAt === 1)?.expireAfterSeconds;
    expect(await ttl(m.DeletedOrgSnapshot)).toBe(0);
    expect(await ttl(m.DeletedOrgSnapshotChunk)).toBe(0);
    expect(await ttl(m.ArchivedAuditEvent)).toBe(0);
  });
});
