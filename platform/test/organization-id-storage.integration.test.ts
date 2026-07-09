// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * REAL-Mongo integration test (NOT mocked) for finding #13 — the Mixed `_id`
 * casting split. Every other platform test fully mocks mongoose, so none can
 * observe how an organization id is actually STORED and QUERIED. This one runs
 * the real `Organization` / `UserOrganization` schemas against an in-memory
 * mongod to establish the authoritative representation before we route all
 * org-id lookups through a single canonical caster.
 *
 * What it pins down:
 *  - `Organization._id` (Schema.Types.Mixed, default `() => new ObjectId()`) is
 *    stored as an ObjectId for a normally-created org.
 *  - A raw-string `findById(<24-hex>)` MISSES that org (Mongoose does not
 *    auto-cast a Mixed field), while `findById(toOrgId(<24-hex>))` HITS it —
 *    this IS the bug behind the raw-string call sites (auth.ts:49, token.ts:114,
 *    active-org-info.ts, etc.), since the JWT carries `String(org._id)`.
 *  - `UserOrganization.organizationId` (Mixed) is stored as an ObjectId when set
 *    from `org._id`, so raw-string membership queries miss too.
 *  - The well-known string `_id` (e.g. 'system') is stored + matched as a
 *    string, so `toOrgId` must leave non-24-hex ids untouched (it does).
 *
 * OPT-IN: self-skips unless `RUN_MONGO_INTEGRATION=1`, so the default `pnpm test`
 * never spins up mongod (the first run downloads a mongod binary). Run with:
 *   RUN_MONGO_INTEGRATION=1 pnpm --filter platform test -- organization-id-storage
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

// The real models transitively import platform config, which validates required
// secrets at load outside dev (jest sets NODE_ENV=test, so the dev fallback is
// off). Provide throwaway values so the import succeeds — this test touches no
// encrypted fields, JWTs, or refresh tokens.
process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.REFRESH_TOKEN_SECRET ||= 'test-only-refresh-secret';

// Pin the mongod build: the default 7.x line SIGABRTs under this runner, while
// 6.0.14 starts cleanly. Overridable via MONGOMS_VERSION.
const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';

const RUN = process.env.RUN_MONGO_INTEGRATION === '1' || process.env.RUN_MONGO_INTEGRATION === 'true';

// Gate the whole suite. When off, the heavy deps below are never imported, so the
// default suite stays fast and needs no running mongod.
const suite = RUN ? describe : describe.skip;

suite('organization id storage (real Mongo, #13)', () => {
  // Loosely typed — deps load dynamically inside beforeAll so a skipped run
  // pulls in nothing (and needs no mongod binary present).
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mongoose: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Types: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Organization: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let UserOrganization: any;
  let toOrgId: (id: string) => unknown;

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mongooseMod = await import('mongoose');
    mongoose = mongooseMod.default;
    Types = mongooseMod.Types;

    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    const uri = mongod.getUri();
    // Platform config validates MONGODB_URI at load; point it at the in-memory
    // server before the model import below pulls config in.
    process.env.MONGODB_URI = uri;
    await mongoose.connect(uri);

    // Import the REAL models + caster AFTER connecting so they bind to the live
    // default connection. These are the exact schemas production uses.
    ({ Organization, UserOrganization } = await import('../src/models/index.js'));
    ({ toOrgId } = await import('../src/helpers/controller-helper.js'));
  }, 120_000); // first run downloads the mongod binary

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  it('stores a normally-created org _id as an ObjectId', async () => {
    const org = await Organization.create({ name: 'Acme', owner: new Types.ObjectId() });
    expect(org._id).toBeInstanceOf(Types.ObjectId);
  });

  it('raw-string findById MISSES an ObjectId _id (the bug); toOrgId cast HITS', async () => {
    const org = await Organization.create({ name: 'Beta', owner: new Types.ObjectId() });
    // The 24-hex string form — this is what rides in the JWT (`lastActiveOrgId`
    // is written as `String(org._id)`) and reaches the raw call sites.
    const idStr = String(org._id);

    const raw = await Organization.findById(idStr);
    const cast = await Organization.findById(toOrgId(idStr));

    expect(raw).toBeNull(); // Mixed _id: string query != stored ObjectId → miss
    expect(cast).not.toBeNull(); // canonical caster converts to ObjectId → hit
    expect(String(cast._id)).toBe(idStr);
  });

  it('stores UserOrganization.organizationId as an ObjectId; raw-string query misses', async () => {
    const org = await Organization.create({ name: 'Gamma', owner: new Types.ObjectId() });
    await UserOrganization.create({ userId: new Types.ObjectId(), organizationId: org._id, role: 'owner' });
    const idStr = String(org._id);

    const stored = await UserOrganization.findOne({ userId: { $exists: true }, role: 'owner' });
    expect(stored.organizationId).toBeInstanceOf(Types.ObjectId);

    const rawMatch = await UserOrganization.findOne({ organizationId: idStr });
    const castMatch = await UserOrganization.findOne({ organizationId: toOrgId(idStr) });
    expect(rawMatch).toBeNull();
    expect(castMatch).not.toBeNull();
  });

  it('stores + matches a well-known string _id ("system") as a string', async () => {
    await Organization.create({ _id: 'system', name: 'System Org', owner: new Types.ObjectId() });

    const found = await Organization.findById('system'); // raw string HITS a string _id
    expect(found).not.toBeNull();
    expect(typeof found._id).toBe('string');
    // toOrgId must leave a non-24-hex id untouched so string ids still match.
    expect(String(toOrgId('system'))).toBe('system');
  });

  // End-to-end proof that the caster FIX works on a real fixed call site:
  // loadActiveOrgInfo takes the string activeOrgId (as carried in the JWT) and
  // must now resolve the org + role. Pre-fix (raw findById(string)) it returned
  // { organizationName: null } for a normally-created ObjectId-_id org.
  it('loadActiveOrgInfo resolves an org from its string id after the caster fix', async () => {
    const { loadActiveOrgInfo } = await import('../src/helpers/active-org-info.js');
    const org = await Organization.create({ name: 'Delta', owner: new Types.ObjectId() });
    const userId = new Types.ObjectId();
    await UserOrganization.create({ userId, organizationId: org._id, role: 'admin' });

    const info = await loadActiveOrgInfo(userId, String(org._id));
    expect(info.organizationName).toBe('Delta');
    expect(info.activeOrgRole).toBe('admin');
  });
});
