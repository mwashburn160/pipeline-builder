// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo integration test for the domain-join (P2b) MODEL INDEXES — the
 * security-critical invariants that unit tests (mocked models) can't exercise:
 *
 *   1. Uniqueness is enforced only among VERIFIED domains (partial unique index),
 *      so an unverified registration can't squat the global namespace.
 *   2. Once a domain is verified for one org, no other org can verify it.
 *   3. A single org can't register the same domain twice.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default) — mirrors
 * organization-id-storage.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.REFRESH_TOKEN_SECRET ||= 'test-only-refresh-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const RUN = process.env.RUN_MONGO_INTEGRATION === '1' || process.env.RUN_MONGO_INTEGRATION === 'true';
const suite = RUN ? describe : describe.skip;

suite('OrgDomain indexes (real Mongo, P2b)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mongoose: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let OrgDomain: any;

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mongooseMod = await import('mongoose');
    mongoose = mongooseMod.default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    const uri = mongod.getUri();
    process.env.MONGODB_URI = uri;
    await mongoose.connect(uri);
    ({ OrgDomain } = await import('../src/models/index.js'));
    // Indexes are built lazily; force them so the unique constraints are live.
    await OrgDomain.syncIndexes();
  }, 120_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  const base = (over: Record<string, unknown>) => ({ domain: 'acme.com', verificationToken: 't', createdBy: 'u1', ...over });

  it('allows two DIFFERENT orgs to hold the same UNVERIFIED domain', async () => {
    await OrgDomain.create(base({ orgId: 'orgA', verified: false }));
    await expect(OrgDomain.create(base({ orgId: 'orgB', verified: false }))).resolves.toBeTruthy();
  });

  it('rejects a SECOND org verifying a domain another org already verified', async () => {
    await OrgDomain.create(base({ domain: 'beta.com', orgId: 'orgA', verified: true }));
    await expect(OrgDomain.create(base({ domain: 'beta.com', orgId: 'orgB', verified: true })))
      .rejects.toThrow(/duplicate key|E11000/i);
  });

  it('rejects the SAME org registering a domain twice', async () => {
    await OrgDomain.create(base({ domain: 'gamma.com', orgId: 'orgC', verified: false }));
    await expect(OrgDomain.create(base({ domain: 'gamma.com', orgId: 'orgC', verified: false })))
      .rejects.toThrow(/duplicate key|E11000/i);
  });
});
