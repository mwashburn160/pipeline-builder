// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for the Organization model's slug pre-validate hook: names
 * with no ASCII alphanumerics must not all collapse onto one empty slug (the
 * second such org used to get "-1"), and long names must yield a slug the
 * edit schema and the per-org namespace both accept.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped by default).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('Organization slug generation (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, slugRule: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    await m.Organization.init();
    slugRule = await import('../src/constants/org-slug.js');
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    await m.Organization.deleteMany({});
  });

  const create = (name: string) => m.Organization.create({ name, owner: new mongoose.Types.ObjectId() });

  it('gives non-Latin names distinct org-<hex> slugs', async () => {
    const a = await create('日本語チーム');
    const b = await create('日本語チーム');
    const c = await create('🚀🔥🎉');
    for (const org of [a, b, c]) expect(org.slug).toMatch(/^org-[0-9a-f]{6}$/);
    expect(new Set([a.slug, b.slug, c.slug]).size).toBe(3);
  });

  it('suffixes colliding Latin names', async () => {
    expect((await create('Acme Corp')).slug).toBe('acme-corp');
    expect((await create('Acme Corp')).slug).toBe('acme-corp-1');
    expect((await create('ACME corp')).slug).toBe('acme-corp-2');
  });

  it('truncates a long name so base-<n> fits the slug rule', async () => {
    const name = 'Extraordinarily Long Organization Name For Testing Truncation Behaviour';
    const first = await create(name);
    const second = await create(name);
    for (const org of [first, second]) {
      expect(org.slug.length).toBeLessThanOrEqual(slugRule.ORG_SLUG_MAX);
      expect(org.slug).toMatch(slugRule.ORG_SLUG_PATTERN);
    }
    expect(second.slug).toBe(`${first.slug}-1`);
  });
});
