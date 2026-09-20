// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `services/scim-service.ts` — the PROVISIONING POLICY.
 *
 * `scim-protocol.test.ts` covers the wire contract (filters, pagination, the
 * error envelope, discovery) with the models stubbed to return nothing, and
 * `scim.integration.test.ts` covers the same service against a real Mongo — but
 * that suite is gated on `RUN_MONGO_INTEGRATION`, so on an ordinary run the
 * decisions below were never executed at all.
 *
 * They are the ones a tenant's identity provider can reach, and each is an
 * authority boundary:
 *   - a membership may only be provisioned at a domain the org has VERIFIED
 *     (otherwise a tenant staples itself onto any account whose address it
 *     knows);
 *   - the org OWNER is never deactivated, and a PLATFORM ADMINISTRATOR is never
 *     touched at all;
 *   - a group carries no `roleIds` — SCIM owns names and members, a human owns
 *     what a group is worth, so a stolen SCIM key cannot invent admin;
 *   - after the SSO entitlement lapses the surface is REMOVAL-ONLY;
 *   - re-provisioning is idempotent: an IdP that re-creates instead of
 *     re-activating gets a 409, never a second membership.
 *
 * The models are a small in-memory double rather than per-test stubs: half of
 * what this module does is express policy as a query filter, and only a store
 * that evaluates the filter can tell a refusal from a stub returning null.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Types } from 'mongoose';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// A minimal Mongo double
// ---------------------------------------------------------------------------

const oid = (v: unknown): string => String(v);
const get = (doc: any, path: string): any => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);

function setPath(doc: any, path: string, value: unknown): void {
  const keys = path.split('.');
  let cursor = doc;
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] === undefined || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

function matchesValue(value: any, cond: any): boolean {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !(cond instanceof Types.ObjectId) && !Array.isArray(cond)) {
    if ('$in' in cond) {
      const wanted = (cond.$in as unknown[]).map(oid);
      return Array.isArray(value) ? value.some((v) => wanted.includes(oid(v))) : wanted.includes(oid(value));
    }
    if ('$ne' in cond) return oid(cond.$ne) !== oid(value);
  }
  if (Array.isArray(value)) return value.some((v) => oid(v) === oid(cond));
  return oid(cond) === oid(value);
}

function matches(doc: any, filter: Record<string, any> = {}): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return (cond as any[]).some((sub) => matches(doc, sub));
    return matchesValue(get(doc, key), cond);
  });
}

function applyUpdate(doc: any, update: Record<string, any> = {}, filter: Record<string, any> = {}): void {
  for (const [path, value] of Object.entries(update.$set ?? {})) {
    if (path.endsWith('.$')) {
      // The positional operator, as `renameGroupKey` uses it.
      const arrayPath = path.slice(0, -2);
      const arr = get(doc, arrayPath) ?? [];
      const index = arr.findIndex((x: unknown) => oid(x) === oid(filter[arrayPath]));
      if (index >= 0) arr[index] = value;
      continue;
    }
    setPath(doc, path, value);
  }
  for (const [path, value] of Object.entries(update.$addToSet ?? {})) {
    const arr = get(doc, path) ?? [];
    if (!arr.some((x: unknown) => oid(x) === oid(value))) arr.push(value);
    setPath(doc, path, arr);
  }
  for (const [path, value] of Object.entries(update.$pull ?? {})) {
    setPath(doc, path, (get(doc, path) ?? []).filter((x: unknown) => oid(x) !== oid(value)));
  }
  for (const [path, by] of Object.entries(update.$inc ?? {})) setPath(doc, path, (get(doc, path) ?? 0) + (by as number));
  for (const path of Object.keys(update.$unset ?? {})) setPath(doc, path, undefined);
}

function query<T>(resolve: () => T): any {
  const chain: any = {
    select: () => chain,
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    session: () => chain,
    lean: () => chain,
    then: (ok: any, fail: any) => Promise.resolve().then(resolve).then(ok, fail),
    catch: (fail: any) => Promise.resolve().then(resolve).catch(fail),
  };
  return chain;
}

const clone = (doc: any) => (doc ? JSON.parse(JSON.stringify(doc, (k, v) => (k === '_id' || k === 'userId' ? String(v) : v))) : null);

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const db = {
  users: [] as any[],
  memberships: [] as any[],
  groups: [] as any[],
};

class UserDoc {
  _id: Types.ObjectId = new Types.ObjectId();
  email = '';
  username = '';
  isSuperAdmin?: boolean;
  tokenVersion = 0;
  isEmailVerified?: boolean;
  constructor(doc: Record<string, unknown> = {}) { Object.assign(this, doc); }
  async save(): Promise<this> {
    if (!db.users.includes(this)) db.users.push(this);
    return this;
  }
}

const User: any = UserDoc;
Object.assign(User, {
  findById: jest.fn((id: unknown) => query(() => clone(db.users.find((u) => oid(u._id) === oid(id)) ?? null))),
  findOne: jest.fn((filter: any) => query(() => db.users.find((u) => matches(u, filter)) ?? null)),
  find: jest.fn((filter: any) => query(() => db.users.filter((u) => matches(u, filter)).map(clone))),
  exists: jest.fn((filter: any) => query(() => (db.users.some((u) => matches(u, filter)) ? { _id: 'x' } : null))),
  updateOne: jest.fn((filter: any, update: any) => query(() => {
    const hit = db.users.find((u) => matches(u, filter));
    if (hit) applyUpdate(hit, update, filter);
    return { modifiedCount: hit ? 1 : 0 };
  })),
});

/** A membership "document": the live object `requireMembership` hands back.
 *  `joinedAt` (schema default) and the `timestamps: true` pair are present on
 *  EVERY real row, so the stub always carries them — the SCIM renderer reads
 *  them unconditionally. */
function membershipDoc(doc: Record<string, unknown>): any {
  const rec: any = {
    _id: new Types.ObjectId(),
    role: 'member',
    isActive: true,
    joinedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...doc,
    set(path: string, value: unknown) { setPath(this, path, value); },
    async save() { return this; },
  };
  return rec;
}

const UserOrganization: any = {
  findOne: jest.fn((filter: any) => query(() => db.memberships.find((m) => matches(m, filter)) ?? null)),
  find: jest.fn((filter: any) => query(() => db.memberships.filter((m) => matches(m, filter)).map(clone))),
  countDocuments: jest.fn((filter: any) => query(() => db.memberships.filter((m) => matches(m, filter)).length)),
  exists: jest.fn((filter: any) => query(() => (db.memberships.some((m) => matches(m, filter)) ? { _id: 'x' } : null))),
  create: jest.fn(async (docs: any[]) => {
    for (const d of docs) {
      if (db.memberships.some((m) => oid(m.userId) === oid(d.userId) && oid(m.organizationId) === oid(d.organizationId))) {
        throw Object.assign(new Error('E11000'), { code: 11000 });
      }
      db.memberships.push(membershipDoc(d));
    }
    return docs;
  }),
  updateOne: jest.fn((filter: any, update: any) => query(() => {
    const hit = db.memberships.find((m) => matches(m, filter));
    if (hit) applyUpdate(hit, update, filter);
    return { modifiedCount: hit ? 1 : 0 };
  })),
  updateMany: jest.fn((filter: any, update: any) => query(() => {
    const hits = db.memberships.filter((m) => matches(m, filter));
    for (const hit of hits) applyUpdate(hit, update, filter);
    return { modifiedCount: hits.length };
  })),
};

function groupDoc(doc: Record<string, unknown>): any {
  const rec: any = {
    _id: new Types.ObjectId(),
    roleIds: [],
    scimExternalId: null,
    scimManaged: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...doc,
    async save() { return this; },
  };
  return rec;
}

const IdpGroupMapping: any = {
  find: jest.fn((filter: any) => query(() => db.groups.filter((g) => matches(g, filter)).map(clone))),
  findOne: jest.fn((filter: any) => query(() => db.groups.find((g) => matches(g, filter)) ?? null)),
  exists: jest.fn((filter: any) => query(() => (db.groups.some((g) => matches(g, filter)) ? { _id: 'x' } : null))),
  countDocuments: jest.fn((filter: any) => query(() => db.groups.filter((g) => matches(g, filter)).length)),
  create: jest.fn(async (doc: any) => { const rec = groupDoc(doc); db.groups.push(rec); return rec; }),
  deleteOne: jest.fn(async (filter: any) => {
    const i = db.groups.findIndex((g) => matches(g, filter));
    if (i >= 0) db.groups.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  }),
};

// ---------------------------------------------------------------------------
// Collaborators
// ---------------------------------------------------------------------------

const mockResolveMappedRoles = jest.fn<(...a: unknown[]) => Promise<{ roleIds: string[]; matchedGroups: string[] }>>(
  async () => ({ roleIds: [], matchedGroups: [] }),
);
const mockSyncMappedRoles = jest.fn<(...a: unknown[]) => Promise<{ added: string[]; removed: string[] }>>(
  async () => ({ added: [], removed: [] }),
);
const mockEnsureBaselineRole = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const mockRecompute = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const mockPublishRevocation = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const mockOwnsVerifiedDomain = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
const seats = {
  available: jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => true),
  stillWithinCap: jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => true),
  hasSeat: jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => false),
  usage: jest.fn<(...a: unknown[]) => Promise<{ limit: number; used: number }>>(async () => ({ limit: 3, used: 3 })),
};

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));
jest.unstable_mockModule('../src/models/user.js', () => ({ default: User }));
jest.unstable_mockModule('../src/models/user-organization.js', () => ({ default: UserOrganization }));
jest.unstable_mockModule('../src/models/idp-group-mapping.js', () => ({ default: IdpGroupMapping }));
jest.unstable_mockModule('../src/services/mapped-roles.js', () => ({
  syncMappedRoles: (...a: unknown[]) => mockSyncMappedRoles(...a),
}));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  ensureBaselineRole: (...a: unknown[]) => mockEnsureBaselineRole(...a),
  recomputeUserOrgRole: (...a: unknown[]) => mockRecompute(...a),
}));
jest.unstable_mockModule('../src/services/idp-group-mapping-service.js', () => ({
  idpGroupMappingService: { resolveMappedRoles: (...a: unknown[]) => mockResolveMappedRoles(...a) },
  MAX_MAPPINGS_PER_ORG: 3,
}));
jest.unstable_mockModule('../src/helpers/seats.js', () => ({
  pooledSeatUsage: (...a: unknown[]) => seats.usage(...a),
  seatCapacityAvailable: (...a: unknown[]) => seats.available(...a),
  seatCapacityStillWithinCap: (...a: unknown[]) => seats.stillWithinCap(...a),
  userHasSeatInAccount: (...a: unknown[]) => seats.hasSeat(...a),
}));
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishUserRevocation: (...a: unknown[]) => mockPublishRevocation(...a),
}));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  emailDomain: (email: string) => { const at = email.lastIndexOf('@'); return at <= 0 ? null : email.slice(at + 1).toLowerCase(); },
  ownsVerifiedDomain: (...a: unknown[]) => mockOwnsVerifiedDomain(...a),
  isSsoEntitled: async () => true,
}));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: async (fn: (s: unknown) => Promise<unknown>) => fn({ id: 'session' }),
}));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { app: { frontendUrl: 'https://pb.example.com/' } } }));

const scim = await import('../src/services/scim-service.js');
const { isScimError } = await import('../src/services/scim-errors.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG = '650000000000000000000001';
const OTHER_ORG = '650000000000000000000002';
const ALICE = '651111111111111111111111';
const BOB = '652222222222222222222222';
const OWNER = '653333333333333333333333';
const ROOT = '654444444444444444444444';
const ABSENT = '659999999999999999999999';

const ctx = (over: Partial<{ orgId: string; entitled: boolean }> = {}) => ({ orgId: ORG, entitled: true, ...over });

function seedUser(id: string, email: string, over: Record<string, unknown> = {}): any {
  const u = new UserDoc({ _id: new Types.ObjectId(id), email, username: email.split('@')[0], tokenVersion: 1, ...over });
  db.users.push(u);
  return u;
}
function seedMembership(userId: string, over: Record<string, unknown> = {}): any {
  const m = membershipDoc({ userId: new Types.ObjectId(userId), organizationId: new Types.ObjectId(ORG), scim: {}, ...over });
  db.memberships.push(m);
  return m;
}
function seedGroup(name: string, over: Record<string, unknown> = {}): any {
  const g = groupDoc({ orgId: ORG, group: name, groupKey: name.trim().toLowerCase(), ...over });
  db.groups.push(g);
  return g;
}

/** Assert a SCIM refusal by its status + stable reason label. */
async function refusal(promise: Promise<unknown>): Promise<{ status: number; reason: string; scimType?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    if (!isScimError(err)) throw err;
    return { status: err.status, reason: err.reason, scimType: err.scimType, message: err.message };
  }
  throw new Error('expected a ScimError, but the call resolved');
}

beforeEach(() => {
  jest.clearAllMocks();
  db.users = [];
  db.memberships = [];
  db.groups = [];
  mockOwnsVerifiedDomain.mockResolvedValue(true);
  seats.available.mockResolvedValue(true);
  seats.stillWithinCap.mockResolvedValue(true);
  seats.hasSeat.mockResolvedValue(false);
  seats.usage.mockResolvedValue({ limit: 3, used: 3 });
  mockSyncMappedRoles.mockResolvedValue({ added: [], removed: [] });
  mockResolveMappedRoles.mockResolvedValue({ roleIds: [], matchedGroups: [] });
});

// ---------------------------------------------------------------------------

describe('createUser — provisioning a membership', () => {
  it('creates the platform account and the membership, and renders the resource', async () => {
    const out = await scim.createUser(ctx(), {
      userName: 'alice@acme.com',
      externalId: '00u1abcd',
      name: { givenName: 'Alice', familyName: 'Ng' },
      displayName: 'Alice Ng',
      emails: [{ value: 'alice@acme.com', primary: true, type: 'work' }],
    });

    expect(out.action).toBe('create');
    expect(out.resource).toMatchObject({
      userName: 'alice@acme.com',
      externalId: '00u1abcd',
      displayName: 'Alice Ng',
      active: true,
      name: { givenName: 'Alice', familyName: 'Ng', formatted: 'Alice Ng' },
      emails: [{ value: 'alice@acme.com', type: 'work', primary: true }],
    });
    // Built from configuration, never from a Host header.
    expect(out.resource.meta.location).toBe(`https://pb.example.com/api/scim/v2/Users/${out.resource.id}`);
    // Always a plain member: a directory never provisions ownership.
    expect(db.memberships[0].role).toBe('member');
    expect(db.memberships[0].scim.managed).toBe(true);
    // Without the built-in Member floor the membership resolves to zero permissions.
    expect(mockEnsureBaselineRole).toHaveBeenCalled();
    expect(db.users[0].isEmailVerified).toBe(true);
  });

  it('probes for a free username when the local part is already taken', async () => {
    seedUser(BOB, 'alice@other.com', { username: 'alice' });
    seedUser(OWNER, 'alice1@other.com', { username: 'alice1' });

    await scim.createUser(ctx(), { userName: 'alice@acme.com' });

    expect(db.users[2].username).toBe('alice2');
  });

  it('reuses an EXISTING platform account rather than minting a second one', async () => {
    const existing = seedUser(ALICE, 'alice@acme.com');

    const out = await scim.createUser(ctx(), { userName: 'alice@acme.com' });

    expect(db.users).toHaveLength(1);
    expect(out.resource.id).toBe(String(existing._id));
  });

  it('REFUSES a domain the organization has not verified', async () => {
    // Without this a tenant could staple a membership onto any account on the
    // platform just by knowing its address.
    mockOwnsVerifiedDomain.mockResolvedValue(false);

    const err = await refusal(scim.createUser(ctx(), { userName: 'alice@evil.com' }));

    expect(err).toMatchObject({ status: 400, scimType: 'invalidValue' });
    expect(err.message).toContain('evil.com');
    expect(db.memberships).toHaveLength(0);
  });

  it('REFUSES a platform administrator', async () => {
    seedUser(ROOT, 'root@acme.com', { isSuperAdmin: true });

    const err = await refusal(scim.createUser(ctx(), { userName: 'root@acme.com' }));

    expect(err).toMatchObject({ status: 403, reason: 'platform_admin' });
    expect(db.memberships).toHaveLength(0);
  });

  it('answers `uniqueness` when the membership already exists — never a second one', async () => {
    seedUser(ALICE, 'alice@acme.com');
    seedMembership(ALICE);

    const err = await refusal(scim.createUser(ctx(), { userName: 'alice@acme.com' }));

    expect(err).toMatchObject({ status: 409, scimType: 'uniqueness' });
    expect(db.memberships).toHaveLength(1);
  });

  it('translates the duplicate-key RACE into the same `uniqueness`, not a 500', async () => {
    UserOrganization.create.mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }) as never);

    const err = await refusal(scim.createUser(ctx(), { userName: 'alice@acme.com' }));

    expect(err).toMatchObject({ status: 409, scimType: 'uniqueness' });
  });

  it('propagates a write failure that is NOT the uniqueness index', async () => {
    UserOrganization.create.mockRejectedValueOnce(new Error('connection reset') as never);
    await expect(scim.createUser(ctx(), { userName: 'alice@acme.com' })).rejects.toThrow('connection reset');
  });

  it('refuses when the pooled seat cap is full, and creates nothing', async () => {
    seats.available.mockResolvedValue(false);
    seats.usage.mockResolvedValue({ limit: 7, used: 7 });

    const err = await refusal(scim.createUser(ctx(), { userName: 'alice@acme.com' }));

    expect(err).toMatchObject({ status: 403, reason: 'seat_limit' });
    expect(err.message).toContain('7 seat(s)');
    expect(err.scimType).toBeUndefined();
    expect(db.memberships).toHaveLength(0);
  });

  it('charges no seat for an INACTIVE create, or for someone already seated in the account', async () => {
    seats.available.mockResolvedValue(false);

    const inactive = await scim.createUser(ctx(), { userName: 'alice@acme.com', active: false });
    expect(inactive.resource.active).toBe(false);

    seedUser(BOB, 'bob@acme.com');
    seats.hasSeat.mockResolvedValue(true);
    const seated = await scim.createUser(ctx(), { userName: 'bob@acme.com' });
    expect(seated.resource.active).toBe(true);
  });

  it('runs the post-commit seat re-check, so a concurrent invite cannot push the account over', async () => {
    seats.stillWithinCap.mockResolvedValue(false);
    const err = await refusal(scim.createUser(ctx(), { userName: 'alice@acme.com' }));
    expect(err.reason).toBe('seat_limit');
  });

  it('takes the email from the primary address, else the first, else an email-shaped userName', async () => {
    await scim.createUser(ctx(), {
      userName: 'ignored',
      emails: [{ value: 'first@acme.com' }, { value: 'primary@acme.com', primary: true }],
    });
    expect(db.users[0].email).toBe('primary@acme.com');

    await scim.createUser(ctx(), { userName: 'x', emails: [{ value: 'FIRST@Acme.com ' }] });
    expect(db.users[1].email).toBe('first@acme.com');

    await scim.createUser(ctx(), { userName: 'bare@acme.com' });
    expect(db.users[2].email).toBe('bare@acme.com');
  });

  it('refuses a body with no usable email address', async () => {
    expect((await refusal(scim.createUser(ctx(), { userName: 'not-an-address' })))).toMatchObject({ scimType: 'invalidValue' });
    expect((await refusal(scim.createUser(ctx(), {})))).toMatchObject({ scimType: 'invalidValue' });
  });

  it('is REFUSED once the SSO entitlement lapses', async () => {
    const err = await refusal(scim.createUser(ctx({ entitled: false }), { userName: 'alice@acme.com' }));
    expect(err).toMatchObject({ status: 403, reason: 'not_entitled' });
    expect(mockOwnsVerifiedDomain).not.toHaveBeenCalled();
  });
});

describe('listUsers / getUser', () => {
  beforeEach(() => {
    seedUser(ALICE, 'alice@acme.com');
    seedUser(BOB, 'bob@acme.com');
    seedMembership(ALICE, { scim: { userName: 'alice@acme.com', externalId: '00u1', groups: ['engineers'] } });
    seedMembership(BOB, { isActive: false, scim: { userName: 'bob@acme.com' } });
    seedGroup('Engineers');
  });

  it('lists the org roster and renders each member\'s groups from the mapping rows', async () => {
    const list = await scim.listUsers(ctx(), {});

    expect(list.totalResults).toBe(2);
    expect(list.startIndex).toBe(1);
    expect(list.itemsPerPage).toBe(2);
    expect(list.Resources[0].groups).toEqual([{ value: String(db.groups[0]._id), display: 'Engineers', type: 'direct' }]);
    expect(list.Resources[1].active).toBe(false);
  });

  it('filters on externalId, on active, and on userName (matching the platform email too)', async () => {
    expect((await scim.listUsers(ctx(), { filter: 'externalId eq "00u1"' })).Resources.map((r) => r.id)).toEqual([ALICE]);
    expect((await scim.listUsers(ctx(), { filter: 'active eq false' })).Resources.map((r) => r.id)).toEqual([BOB]);
    // The directory's spelling OR the platform address — so a lookup matches
    // whether or not SCIM created the membership.
    expect((await scim.listUsers(ctx(), { filter: 'userName eq "alice@acme.com"' })).Resources.map((r) => r.id)).toEqual([ALICE]);
    expect((await scim.listUsers(ctx(), { filter: 'emails.value eq "nobody@acme.com"' })).Resources).toEqual([]);
  });

  it('returns the count without the page when `count` is zero', async () => {
    const list = await scim.listUsers(ctx(), { count: '0' });
    expect(list.totalResults).toBe(2);
    expect(list.Resources).toEqual([]);
  });

  it('skips a membership whose account was hard-deleted rather than rendering an identity-less resource', async () => {
    db.users = db.users.filter((u) => oid(u._id) !== ALICE);
    const list = await scim.listUsers(ctx(), {});
    expect(list.totalResults).toBe(2);
    expect(list.Resources.map((r) => r.id)).toEqual([BOB]);
  });

  it('never leaks another org\'s roster', async () => {
    expect((await scim.listUsers(ctx({ orgId: OTHER_ORG }), {})).Resources).toEqual([]);
  });

  it('answers 404 for a malformed id, an unknown id, and a membership whose account is gone', async () => {
    expect((await refusal(scim.getUser(ctx(), 'nope'))).status).toBe(404);
    expect((await refusal(scim.getUser(ctx(), ABSENT))).status).toBe(404);
    db.users = db.users.filter((u) => oid(u._id) !== ALICE);
    expect((await refusal(scim.getUser(ctx(), ALICE))).status).toBe(404);
  });
});

describe('replaceUser (PUT)', () => {
  beforeEach(() => {
    seedUser(ALICE, 'alice@acme.com');
    seedMembership(ALICE, { scim: { userName: 'alice@acme.com', groups: [] } });
  });

  it('applies the directory-owned attributes and names what moved', async () => {
    const out = await scim.replaceUser(ctx(), ALICE, {
      userName: 'alice@acme.com', externalId: '00u9', name: { givenName: 'Alice' }, displayName: 'Alice',
    });

    expect(out.action).toBe('update');
    expect(out.changed).toEqual(['externalId', 'givenName', 'displayName']);
    expect(out.resource.externalId).toBe('00u9');
  });

  it('treats an unchanged body as a no-op update', async () => {
    const out = await scim.replaceUser(ctx(), ALICE, { userName: 'alice@acme.com' });
    expect(out.changed).toEqual([]);
  });

  it('refuses to RENAME an adopted membership — userName is write-once', async () => {
    // Re-pointing a membership at another address would be an account takeover
    // by rename; the IdP must remove and re-provision instead.
    const err = await refusal(scim.replaceUser(ctx(), ALICE, { userName: 'eve@acme.com' }));
    expect(err).toMatchObject({ status: 400, scimType: 'mutability' });
  });

  it('accepts the FIRST claim on a membership SCIM is adopting', async () => {
    db.memberships[0].scim = {};
    const out = await scim.replaceUser(ctx(), ALICE, { userName: 'alice@acme.com' });
    expect(out.changed).toContain('userName');
  });

  it('reads a Mongoose sub-document through toObject() rather than spreading its internals', async () => {
    // Spreading a sub-document copies `$__`/`_doc` and NONE of the schema
    // fields, which silently emptied the write-once check.
    const stored = { userName: 'alice@acme.com', groups: [], toObject: () => ({ userName: 'alice@acme.com', groups: [] }) };
    db.memberships[0].scim = stored;
    const err = await refusal(scim.replaceUser(ctx(), ALICE, { userName: 'mallory@acme.com' }));
    expect(err.scimType).toBe('mutability');
  });

  it('DEACTIVATES: sessions end in the same breath, and the mapped Roles fall away', async () => {
    mockSyncMappedRoles.mockResolvedValue({ added: [], removed: ['role-1'] });

    const out = await scim.replaceUser(ctx(), ALICE, { userName: 'alice@acme.com', active: false });

    expect(out.action).toBe('deactivate');
    expect(out.resource.active).toBe(false);
    // `requireAuth` only re-reads tokenVersion, so without the bump a removed
    // member keeps full access until their token expires. Two bumps: one for
    // the session revocation, one for the Role set the directory just dropped.
    expect(db.users[0].tokenVersion).toBe(3);
    expect(db.users[0].refreshSessions).toEqual([]);
    expect(mockPublishRevocation).toHaveBeenCalledWith(ALICE);
    expect(mockResolveMappedRoles).toHaveBeenCalledWith(ORG, []);
  });

  it('a deactivation still works after the entitlement lapses; anything else does not', async () => {
    const out = await scim.replaceUser(ctx({ entitled: false }), ALICE, { userName: 'alice@acme.com', active: false });
    expect(out.action).toBe('deactivate');
    // The attributes are deliberately ignored rather than half-applied.
    expect(out.changed).toEqual(['active']);

    // An attribute change on a LIVE membership is an update, and an update does
    // not survive the downgrade. (The requested state decides, so the member is
    // put back first — a body with no `active` inherits the current one.)
    db.memberships[0].isActive = true;
    const err = await refusal(scim.replaceUser(ctx({ entitled: false }), ALICE, { displayName: 'Alice' }));
    expect(err.reason).toBe('not_entitled');
  });

  it('re-sending `active:false` for an already-inactive member stays a no-op success', async () => {
    db.memberships[0].isActive = false;
    const out = await scim.replaceUser(ctx({ entitled: false }), ALICE, { active: false });
    expect(out.changed).toEqual([]);
    expect(mockPublishRevocation).not.toHaveBeenCalled();
  });

  it('REACTIVATES through the pooled seat cap and restores the Roles the groups map to', async () => {
    db.memberships[0].isActive = false;
    db.memberships[0].scim = { userName: 'alice@acme.com', groups: ['engineers'] };
    mockSyncMappedRoles.mockResolvedValue({ added: ['role-1'], removed: [] });

    const out = await scim.replaceUser(ctx(), ALICE, { active: true });

    expect(out.resource.active).toBe(true);
    expect(mockResolveMappedRoles).toHaveBeenCalledWith(ORG, ['engineers']);
    expect(mockRecompute).toHaveBeenCalled();
    expect(mockPublishRevocation).toHaveBeenCalledWith(ALICE);
  });

  it('refuses a reactivation the seat cap cannot fund — before and after the write', async () => {
    db.memberships[0].isActive = false;
    seats.available.mockResolvedValue(false);
    expect((await refusal(scim.replaceUser(ctx(), ALICE, { active: true }))).reason).toBe('seat_limit');

    seats.available.mockResolvedValue(true);
    seats.stillWithinCap.mockResolvedValue(false);
    expect((await refusal(scim.replaceUser(ctx(), ALICE, { active: true }))).reason).toBe('seat_limit');
  });

  it('a member already seated elsewhere in the account reactivates without a seat check', async () => {
    db.memberships[0].isActive = false;
    seats.hasSeat.mockResolvedValue(true);
    seats.available.mockResolvedValue(false);
    const out = await scim.replaceUser(ctx(), ALICE, { active: true });
    expect(out.resource.active).toBe(true);
  });

  it('NEVER deactivates the org owner, and never touches a platform administrator', async () => {
    db.memberships[0].role = 'owner';
    expect((await refusal(scim.replaceUser(ctx(), ALICE, { active: false }))).reason).toBe('owner_protected');

    db.memberships[0].role = 'member';
    db.users[0].isSuperAdmin = true;
    expect((await refusal(scim.replaceUser(ctx(), ALICE, { active: false }))).reason).toBe('platform_admin');
  });
});

describe('patchUser (PATCH)', () => {
  beforeEach(() => {
    seedUser(ALICE, 'alice@acme.com');
    seedMembership(ALICE, { scim: { userName: 'alice@acme.com', groups: [] } });
  });

  it('reads the Microsoft Entra deactivate shape (explicit path, string "False")', async () => {
    const out = await scim.patchUser(ctx(), ALICE, [{ op: 'Replace', path: 'active', value: 'False' }]);
    expect(out.action).toBe('deactivate');
    expect(out.resource.active).toBe(false);
  });

  it('reads the Okta deactivate shape (path-less value object)', async () => {
    const out = await scim.patchUser(ctx(), ALICE, [{ op: 'replace', value: { active: false } }]);
    expect(out.action).toBe('deactivate');
  });

  it('reports a reactivation as `activate`', async () => {
    db.memberships[0].isActive = false;
    const out = await scim.patchUser(ctx(), ALICE, [{ op: 'replace', path: 'active', value: true }]);
    expect(out.action).toBe('activate');
  });

  it('patches every modelled attribute, and CLEARS one a `remove` names', async () => {
    const out = await scim.patchUser(ctx(), ALICE, [
      { op: 'replace', path: 'externalId', value: '00uZ' },
      { op: 'replace', path: 'displayName', value: 'Alice N' },
      { op: 'replace', path: 'name.givenName', value: 'Alice' },
      { op: 'add', path: 'name.familyName', value: 'Ng' },
    ]);
    // Reported in the module's own attribute order, not the order they arrived.
    expect(out.changed).toEqual(['externalId', 'givenName', 'familyName', 'displayName']);

    const cleared = await scim.patchUser(ctx(), ALICE, [{ op: 'remove', path: 'displayName' }]);
    expect(cleared.changed).toEqual(['displayName']);
    expect(cleared.resource.displayName).toBeUndefined();
  });

  it('a `remove` on `active` is a deactivation', async () => {
    const out = await scim.patchUser(ctx(), ALICE, [{ op: 'remove', path: 'active' }]);
    expect(out.action).toBe('deactivate');
  });

  it('IGNORES an attribute this API does not model rather than failing the whole run', async () => {
    // Entra and Okta send phone numbers and the enterprise extension
    // unconditionally; a 400 would stall provisioning over a no-op.
    const out = await scim.patchUser(ctx(), ALICE, [
      { op: 'replace', path: 'phoneNumbers', value: '555' },
      { op: 'replace', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'Eng' },
    ]);
    expect(out.changed).toEqual([]);
    expect(out.action).toBe('update');
  });

  it('still refuses a MALFORMED operation', async () => {
    expect((await refusal(scim.patchUser(ctx(), ALICE, []))).scimType).toBe('invalidSyntax');
    expect((await refusal(scim.patchUser(ctx(), ALICE, 'nope'))).scimType).toBe('invalidSyntax');
    expect((await refusal(scim.patchUser(ctx(), ALICE, [{ op: 'move', path: 'active', value: false }]))).scimType).toBe('invalidSyntax');
    expect((await refusal(scim.patchUser(ctx(), ALICE, [{ op: 'replace' }]))).scimType).toBe('invalidSyntax');
    expect((await refusal(scim.patchUser(ctx(), ALICE, [{ op: 'replace', value: ['a'] }]))).scimType).toBe('invalidSyntax');
    expect((await refusal(scim.patchUser(ctx(), ALICE, [{ op: 'replace', path: 'active', value: 7 }]))).scimType).toBe('invalidValue');
  });

  it('after a downgrade accepts a deactivation and NOTHING else', async () => {
    const err = await refusal(scim.patchUser(ctx({ entitled: false }), ALICE, [
      { op: 'replace', value: { active: false, displayName: 'Alice' } },
    ]));
    expect(err.reason).toBe('not_entitled');

    expect((await refusal(scim.patchUser(ctx({ entitled: false }), ALICE, [{ op: 'replace', path: 'displayName', value: 'A' }]))).reason)
      .toBe('not_entitled');

    const ok = await scim.patchUser(ctx({ entitled: false }), ALICE, [{ op: 'replace', path: 'active', value: false }]);
    expect(ok.action).toBe('deactivate');
  });
});

describe('deleteUser (DELETE)', () => {
  beforeEach(() => {
    seedUser(ALICE, 'alice@acme.com');
    seedMembership(ALICE, { scim: { userName: 'alice@acme.com', groups: ['engineers'] } });
  });

  it('deactivates, revokes, empties the group set — and KEEPS the row', async () => {
    const out = await scim.deleteUser(ctx(), ALICE);

    expect(out).toMatchObject({ action: 'delete', changed: ['active'], resource: { id: ALICE } });
    expect(db.memberships[0].isActive).toBe(false);
    expect(db.memberships[0].scim.groups).toEqual([]);
    // The row carries the audit trail, the hand-granted Roles and the seat
    // accounting; a deactivated membership grants nothing.
    expect(db.memberships).toHaveLength(1);
    expect(mockPublishRevocation).toHaveBeenCalledWith(ALICE);
    expect(db.users[0].tokenVersion).toBe(2);
  });

  it('is idempotent — deleting an already-removed user does no further work', async () => {
    db.memberships[0].isActive = false;
    db.memberships[0].scim = { groups: [] };

    const out = await scim.deleteUser(ctx(), ALICE);

    expect(out.action).toBe('delete');
    expect(mockPublishRevocation).not.toHaveBeenCalled();
  });

  it('survives a downgrade, but never removes the owner or a platform administrator', async () => {
    const out = await scim.deleteUser(ctx({ entitled: false }), ALICE);
    expect(out.action).toBe('delete');

    db.memberships[0].role = 'owner';
    expect((await refusal(scim.deleteUser(ctx(), ALICE))).reason).toBe('owner_protected');

    db.memberships[0].role = 'member';
    db.users[0].isSuperAdmin = true;
    expect((await refusal(scim.deleteUser(ctx(), ALICE))).reason).toBe('platform_admin');
  });

  it('answers 404 for an unknown member', async () => {
    expect((await refusal(scim.deleteUser(ctx(), ABSENT))).status).toBe(404);
  });
});

describe('Groups', () => {
  beforeEach(() => {
    seedUser(ALICE, 'alice@acme.com');
    seedUser(BOB, 'bob@acme.com');
    seedMembership(ALICE, { scim: { groups: ['engineers'] } });
    seedMembership(BOB, { scim: { groups: [] } });
  });

  it('creates a group that grants NOTHING until a human maps it to Roles', async () => {
    const out = await scim.createGroup(ctx(), { displayName: ' Platform Engineers ', externalId: 'g-1', members: [{ value: BOB }] });

    expect(out.action).toBe('create');
    expect(out.resource).toMatchObject({ displayName: 'Platform Engineers', externalId: 'g-1' });
    expect(out.resource.members).toEqual([{ value: BOB, display: 'bob@acme.com', type: 'User' }]);
    // The one property that keeps a stolen SCIM key from being an escalation
    // primitive: SCIM never writes `roleIds`.
    expect(db.groups[0].roleIds).toEqual([]);
    expect(db.groups[0].createdBy).toBe('scim');
    expect(out.affectedUserIds).toEqual([BOB]);
  });

  it('refuses a nameless group, a duplicate name, and one past the per-org cap', async () => {
    expect((await refusal(scim.createGroup(ctx(), {}))).scimType).toBe('invalidValue');

    seedGroup('Engineers');
    expect((await refusal(scim.createGroup(ctx(), { displayName: 'engineers' }))).scimType).toBe('uniqueness');

    seedGroup('Design');
    seedGroup('Sales');
    expect((await refusal(scim.createGroup(ctx(), { displayName: 'Ops' }))).scimType).toBe('invalidValue');
  });

  it('refuses a member list that is malformed, oversized, or names someone not provisioned here', async () => {
    expect((await refusal(scim.createGroup(ctx(), { displayName: 'A', members: 'bob' }))).scimType).toBe('invalidSyntax');
    expect((await refusal(scim.createGroup(ctx(), { displayName: 'A', members: [{ value: 'not-an-id' }] }))).scimType).toBe('invalidValue');
    // A group is a set of people the directory provisioned HERE, never a way
    // into another tenant's roster.
    const err = await refusal(scim.createGroup(ctx(), { displayName: 'A', members: [{ value: ABSENT }] }));
    expect(err.scimType).toBe('invalidValue');
    expect(err.message).toContain(ABSENT);

    const tooMany = Array.from({ length: 2001 }, () => ({ value: ALICE }));
    expect((await refusal(scim.createGroup(ctx(), { displayName: 'A', members: tooMany }))).scimType).toBe('invalidValue');
  });

  it('accepts a bare string member id and de-duplicates repeats', async () => {
    const out = await scim.createGroup(ctx(), { displayName: 'A', members: [ALICE, { value: ALICE }] });
    expect(out.affectedUserIds).toEqual([ALICE]);
  });

  it('lists and fetches groups, filtered by displayName or externalId', async () => {
    seedGroup('Engineers', { scimExternalId: 'g-eng' });
    seedGroup('Design');

    expect((await scim.listGroups(ctx(), {})).totalResults).toBe(2);
    expect((await scim.listGroups(ctx(), { filter: 'displayName eq "engineers"' })).Resources.map((g) => g.displayName)).toEqual(['Engineers']);
    expect((await scim.listGroups(ctx(), { filter: 'externalId eq "g-eng"' })).Resources.map((g) => g.externalId)).toEqual(['g-eng']);
    expect((await scim.listGroups(ctx(), { count: '0' })).Resources).toEqual([]);

    const one = await scim.getGroup(ctx(), String(db.groups[0]._id));
    expect(one.members).toEqual([{ value: ALICE, display: 'alice@acme.com', type: 'User' }]);
    expect(one.meta.location).toContain('/Groups/');
  });

  it('answers 404 for a malformed or unknown group id, and never another org\'s group', async () => {
    seedGroup('Engineers');
    expect((await refusal(scim.getGroup(ctx(), 'nope'))).status).toBe(404);
    expect((await refusal(scim.getGroup(ctx(), ABSENT))).status).toBe(404);
    expect((await refusal(scim.getGroup(ctx({ orgId: OTHER_ORG }), String(db.groups[0]._id)))).status).toBe(404);
  });

  it('PUT renames a group and carries every member\'s stored key across with it', async () => {
    const group = seedGroup('Engineers');

    const out = await scim.replaceGroup(ctx(), String(group._id), { displayName: 'Platform Engineers' });

    expect(out.changed).toEqual(['displayName']);
    expect(group.groupKey).toBe('platform engineers');
    // Members carry the KEY; without the carry-across everyone silently drops
    // out of the group and loses the Roles it maps to.
    expect(db.memberships[0].scim.groups).toEqual(['platform engineers']);
  });

  it('PUT replaces the member set only when `members` is present', async () => {
    const group = seedGroup('Engineers');

    const untouched = await scim.replaceGroup(ctx(), String(group._id), { displayName: 'Engineers' });
    expect(untouched.changed).toEqual([]);
    expect(db.memberships[0].scim.groups).toEqual(['engineers']);

    const replaced = await scim.replaceGroup(ctx(), String(group._id), { members: [{ value: BOB }] });
    expect(replaced.action).toBe('update');
    expect(replaced.changed).toContain('members');
    expect(db.memberships[0].scim.groups).toEqual([]);
    expect(db.memberships[1].scim.groups).toEqual(['engineers']);

    const cleared = await scim.replaceGroup(ctx(), String(group._id), { members: [] });
    expect(cleared.action).toBe('members');
    expect(db.memberships[1].scim.groups).toEqual([]);
  });

  it('PUT updates externalId, and refuses a rename onto an existing name', async () => {
    const group = seedGroup('Engineers');
    seedGroup('Design');

    const out = await scim.replaceGroup(ctx(), String(group._id), { externalId: 'g-eng' });
    expect(out.changed).toEqual(['externalId']);

    expect((await refusal(scim.replaceGroup(ctx(), String(group._id), { displayName: 'Design' }))).scimType).toBe('uniqueness');
  });

  it('PUT after a downgrade may only REMOVE members', async () => {
    const group = seedGroup('Engineers');

    expect((await refusal(scim.replaceGroup(ctx({ entitled: false }), String(group._id), { displayName: 'Renamed' }))).reason)
      .toBe('not_entitled');
    expect((await refusal(scim.replaceGroup(ctx({ entitled: false }), String(group._id), { members: [{ value: BOB }] }))).reason)
      .toBe('not_entitled');

    const removal = await scim.replaceGroup(ctx({ entitled: false }), String(group._id), { members: [] });
    expect(removal.changed).toContain('members');
  });

  it('PATCH adds, removes and replaces members — including Okta\'s filtered single removal', async () => {
    const group = seedGroup('Engineers');

    const added = await scim.patchGroup(ctx(), String(group._id), [{ op: 'add', path: 'members', value: [{ value: BOB }] }]);
    expect(added.affectedUserIds).toEqual([BOB]);
    expect(db.memberships[1].scim.groups).toEqual(['engineers']);

    const removed = await scim.patchGroup(ctx(), String(group._id), [{ op: 'remove', path: `members[value eq "${BOB}"]` }]);
    expect(removed.action).toBe('members');
    expect(db.memberships[1].scim.groups).toEqual([]);

    const replaced = await scim.patchGroup(ctx(), String(group._id), [{ op: 'replace', path: 'members', value: [{ value: BOB }] }]);
    expect(replaced.action).toBe('update');
    expect(db.memberships[0].scim.groups).toEqual([]);
    expect(db.memberships[1].scim.groups).toEqual(['engineers']);
  });

  it('PATCH clears the group on a bare `remove` of members, and tolerates a path-less op', async () => {
    const group = seedGroup('Engineers');

    const pathless = await scim.patchGroup(ctx(), String(group._id), [{ op: 'add', value: { members: [{ value: BOB }] } }]);
    expect(pathless.affectedUserIds.sort()).toEqual([BOB]);

    const cleared = await scim.patchGroup(ctx(), String(group._id), [{ op: 'remove', path: 'members' }]);
    expect(cleared.affectedUserIds.sort()).toEqual([ALICE, BOB].sort());
    expect(db.memberships.every((m) => m.scim.groups.length === 0)).toBe(true);
  });

  it('PATCH renames, sets externalId, and ignores an unmodelled attribute', async () => {
    const group = seedGroup('Engineers');

    const out = await scim.patchGroup(ctx(), String(group._id), [
      { op: 'replace', path: 'displayName', value: 'Platform' },
      { op: 'replace', path: 'externalId', value: 'g-9' },
      { op: 'replace', path: 'description', value: 'ignored' },
    ]);

    expect(out.changed).toEqual(['displayName', 'externalId']);
    expect(out.action).toBe('update');
    expect(group.group).toBe('Platform');

    seedGroup('Design');
    expect((await refusal(scim.patchGroup(ctx(), String(group._id), [{ op: 'replace', path: 'displayName', value: 'Design' }]))).scimType)
      .toBe('uniqueness');
  });

  it('PATCH never re-adds a current member, and never removes one the same request added', async () => {
    const group = seedGroup('Engineers');

    const out = await scim.patchGroup(ctx(), String(group._id), [
      { op: 'add', path: 'members', value: [{ value: ALICE }] },
      { op: 'remove', path: `members[value eq "${ALICE}"]` },
    ]);

    expect(out.affectedUserIds).toEqual([]);
    expect(db.memberships[0].scim.groups).toEqual(['engineers']);
  });

  it('PATCH refuses a malformed PatchOp and a filtered path used with the wrong op', async () => {
    const group = seedGroup('Engineers');
    expect((await refusal(scim.patchGroup(ctx(), String(group._id), []))).scimType).toBe('invalidSyntax');
    expect((await refusal(scim.patchGroup(ctx(), String(group._id), [{ op: 'move', path: 'members' }]))).scimType).toBe('invalidSyntax');
    expect((await refusal(scim.patchGroup(ctx(), String(group._id), [{ op: 'add', path: `members[value eq "${BOB}"]` }]))).scimType)
      .toBe('invalidSyntax');
  });

  it('PATCH removal of someone already un-provisioned succeeds — the outcome is already true', async () => {
    const group = seedGroup('Engineers');
    const out = await scim.patchGroup(ctx(), String(group._id), [{ op: 'remove', path: 'members', value: [{ value: ABSENT }] }]);
    expect(out.affectedUserIds).toEqual([]);
  });

  it('PATCH after a downgrade may only REMOVE', async () => {
    const group = seedGroup('Engineers');

    expect((await refusal(scim.patchGroup(ctx({ entitled: false }), String(group._id), [{ op: 'add', path: 'members', value: [{ value: BOB }] }]))).reason)
      .toBe('not_entitled');
    expect((await refusal(scim.patchGroup(ctx({ entitled: false }), String(group._id), [{ op: 'replace', path: 'externalId', value: 'g' }]))).reason)
      .toBe('not_entitled');

    const removal = await scim.patchGroup(ctx({ entitled: false }), String(group._id), [{ op: 'remove', path: `members[value eq "${ALICE}"]` }]);
    expect(removal.affectedUserIds).toEqual([ALICE]);
  });

  it('DELETE drops the row and takes every member\'s mapped Roles with it', async () => {
    const group = seedGroup('Engineers');
    mockSyncMappedRoles.mockResolvedValue({ added: [], removed: ['role-1'] });

    const out = await scim.deleteGroup(ctx({ entitled: false }), String(group._id));

    expect(out).toMatchObject({ action: 'delete', changed: ['members'], affectedUserIds: [ALICE] });
    expect(db.groups).toHaveLength(0);
    expect(db.memberships[0].scim.groups).toEqual([]);
    // A rename of the mapped Roles is a token-affecting change.
    expect(mockPublishRevocation).toHaveBeenCalledWith(ALICE);
  });

  it('DELETE answers 404 for an unknown group', async () => {
    expect((await refusal(scim.deleteGroup(ctx(), ABSENT))).status).toBe(404);
  });
});

describe('rendering edges and the defensive fallbacks a partial record leaves behind', () => {
  beforeEach(() => {
    seedUser(ALICE, 'alice@acme.com');
    seedUser(BOB, 'bob@acme.com');
  });

  it('renders a membership that carries no SCIM state at all', async () => {
    // A membership created by an invite, which SCIM is only now reading.
    seedMembership(ALICE, { scim: undefined });

    const resource = await scim.getUser(ctx(), ALICE);

    expect(resource).toMatchObject({ userName: 'alice@acme.com', active: true, groups: [] });
    expect(resource.externalId).toBeUndefined();
    expect(resource.name).toBeUndefined();
  });

  it('adopts a membership with no SCIM state on the first write, and removes one cleanly', async () => {
    seedMembership(ALICE, { scim: undefined });
    const adopted = await scim.replaceUser(ctx(), ALICE, { userName: 'alice@acme.com', externalId: '00u1' });
    expect(adopted.changed).toEqual(['externalId', 'userName']);

    seedMembership(BOB, { scim: undefined });
    const removed = await scim.deleteUser(ctx(), BOB);
    expect(removed.action).toBe('delete');
    expect(db.memberships[1].isActive).toBe(false);
  });

  it('reactivates a membership with no stored group set', async () => {
    seedMembership(ALICE, { scim: undefined, isActive: false });
    const out = await scim.replaceUser(ctx(), ALICE, { active: true });
    expect(out.resource.active).toBe(true);
    expect(mockResolveMappedRoles).toHaveBeenCalledWith(ORG, []);
  });

  it('renders a half-populated name, and reads the membership timestamps directly', async () => {
    // `joinedAt` carries a schema default and `updatedAt` comes from
    // `timestamps: true`, so a tier-less/timestamp-less membership cannot exist —
    // the renderer reads both fields with no fallback chain.
    seedMembership(ALICE, {
      scim: { familyName: 'Ng' },
      joinedAt: new Date('2026-02-01T00:00:00.000Z'),
      updatedAt: new Date('2026-02-03T00:00:00.000Z'),
    });
    seedMembership(BOB, { scim: { givenName: 'Bob' } });

    const [alice, bob] = (await scim.listUsers(ctx(), {})).Resources;

    expect(alice.name).toEqual({ familyName: 'Ng', formatted: 'Ng' });
    expect(alice.meta.created).toBe('2026-02-01T00:00:00.000Z');
    expect(alice.meta.lastModified).toBe('2026-02-03T00:00:00.000Z');
    expect(bob.name).toEqual({ givenName: 'Bob', formatted: 'Bob' });
    expect(bob.meta.created).toBe('2026-01-01T00:00:00.000Z');
  });

  it('renders a group\'s stored timestamps, and a member whose account has gone', async () => {
    seedMembership(BOB, { scim: { groups: ['engineers'] } });
    // `IdpGroupMapping` declares `timestamps: true` and neither query feeding
    // `groupResource` projects, so a mapping row always carries both stamps.
    const group = seedGroup('Engineers');
    db.users = db.users.filter((u) => oid(u._id) !== BOB);

    const rendered = await scim.getGroup(ctx(), String(group._id));

    expect(rendered.meta.created).toBe('2026-01-01T00:00:00.000Z');
    expect(rendered.meta.lastModified).toBe('2026-01-02T00:00:00.000Z');
    // No identity left to display — the id is better than `undefined`.
    expect(rendered.members).toEqual([{ value: BOB, display: BOB, type: 'User' }]);
  });

  it('names the EMAIL in a uniqueness refusal when the body carried no userName', async () => {
    seedMembership(ALICE);
    const existing = await refusal(scim.createUser(ctx(), { emails: [{ value: 'alice@acme.com', primary: true }] }));
    expect(existing.message).toContain('alice@acme.com');

    UserOrganization.create.mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }) as never);
    const raced = await refusal(scim.createUser(ctx(), { emails: [{ value: 'carol@acme.com', primary: true }] }));
    expect(raced.message).toContain('carol@acme.com');
  });

  it('falls back to a generic username when the local part has no usable characters', async () => {
    await scim.createUser(ctx(), { userName: '...@acme.com' });
    expect(db.users[2].username).toBe('user');
  });

  it('refuses a PATCH operation with no `op` at all, on Users and on Groups', async () => {
    seedMembership(ALICE);
    const group = seedGroup('Engineers');

    expect((await refusal(scim.patchUser(ctx(), ALICE, [{ path: 'active', value: false }]))).scimType).toBe('invalidSyntax');
    expect((await refusal(scim.patchGroup(ctx(), String(group._id), [{ path: 'members', value: [] }]))).scimType).toBe('invalidSyntax');
  });

  it('CLEARS every directory-owned attribute a `remove` names', async () => {
    seedMembership(ALICE, { scim: { userName: 'alice@acme.com', externalId: '00u1', givenName: 'Alice', familyName: 'Ng', groups: [] } });

    const out = await scim.patchUser(ctx(), ALICE, [
      { op: 'remove', path: 'userName' },
      { op: 'remove', path: 'externalId' },
      { op: 'remove', path: 'name.givenName' },
      { op: 'remove', path: 'name.familyName' },
    ]);

    expect(out.changed).toEqual(['externalId', 'userName', 'givenName', 'familyName']);
    // With no directory-owned userName left, the resource falls back to the
    // platform address rather than rendering an empty identity.
    expect(out.resource.userName).toBe('alice@acme.com');
    expect(out.resource.externalId).toBeUndefined();
    expect(out.resource.name).toBeUndefined();
  });

  it('treats a valueless group PATCH as an empty string rather than the literal "undefined"', async () => {
    const group = seedGroup('Engineers');

    const out = await scim.patchGroup(ctx(), String(group._id), [
      { op: 'replace', path: 'displayName' },
      { op: 'replace', path: 'externalId' },
    ]);

    // An empty displayName is NOT a rename — that would erase the group's name.
    expect(group.group).toBe('Engineers');
    expect(out.changed).toEqual(['externalId']);
    expect(group.scimExternalId).toBe('');
  });
});
