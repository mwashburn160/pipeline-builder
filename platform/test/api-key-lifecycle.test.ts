// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `apiKeyService` MINT / LIST / REVOKE / ROTATE — the other half of the opaque
 * key model.
 *
 * `api-key-exchange-service.test.ts` covers the exchange; this covers how a key
 * comes into existence and how it goes away. Both ran only inside the
 * Mongo-gated `access-keys.integration.test.ts` / `service-accounts.integration.test.ts`
 * before, so on an ordinary run — the one a developer sees locally — nothing
 * exercised key minting at all.
 *
 * The properties under test are the ones a regression would quietly undo:
 *   - the RAW key is returned exactly once and only `sha256(key)` is stored, so
 *     the secret cannot be read back out of the collection or a view;
 *   - the active-key CAP is enforced per user, so a stolen session cannot mint
 *     thousands of durable credentials;
 *   - a key inherits the creating session's assurance (`amr`/`aal`/`authTime`)
 *     and can never raise it — and a SERVICE-ACCOUNT key inherits none
 *     (`amr: []`), which is what keeps it from satisfying a step-up;
 *   - revoke is SCOPED to the owner: another user's (or another account's) key
 *     id is a miss, not a revocation;
 *   - rotation mints a SIBLING and leaves the presented key live, inherits its
 *     scope/allowlist/lifetime, never widens authority, and never prunes the
 *     key the caller is holding.
 *
 * The collection is a small in-memory double — the same tool as
 * `mfa-recovery-service.test.ts` — because half of what this service does is
 * express a rule as a query filter (`revoked: false`, `userId`, `$gt: now`),
 * and only a store that evaluates the filter can tell a refusal from a stub
 * returning null.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Types } from 'mongoose';
import type { SessionAuth } from '../src/utils/token.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

// ---------------------------------------------------------------------------
// A minimal Mongo double for the key collection
// ---------------------------------------------------------------------------

const oid = (v: unknown): string => String(v);

function matches(doc: any, filter: Record<string, any> = {}): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !(cond instanceof Types.ObjectId)) {
      if ('$in' in cond) return (cond.$in as unknown[]).map(oid).includes(oid(value));
      if ('$gt' in cond) return new Date(value).getTime() > new Date(cond.$gt).getTime();
      if ('$lt' in cond) return new Date(value).getTime() < new Date(cond.$lt).getTime();
      if ('$ne' in cond) return oid(cond.$ne) !== oid(value);
    }
    return oid(cond) === oid(value);
  });
}

function sortDocs(docs: any[], spec: Record<string, number> = {}): any[] {
  const [field, direction] = Object.entries(spec)[0] ?? [];
  if (!field) return docs;
  return [...docs].sort((a, b) => {
    const delta = new Date(a[field]).getTime() - new Date(b[field]).getTime();
    return (direction as number) < 0 ? -delta : delta;
  });
}

/** A chainable query double that honours `sort` (order is asserted, and the
 *  rotation prune depends on oldest-first). */
function query(resolve: (spec: Record<string, number>) => unknown): any {
  let spec: Record<string, number> = {};
  const chain: any = {
    sort: (s: Record<string, number>) => { spec = s; return chain; },
    select: () => chain,
    skip: () => chain,
    limit: () => chain,
    session: () => chain,
    lean: () => chain,
    then: (ok: any, fail: any) => Promise.resolve().then(() => resolve(spec)).then(ok, fail),
    catch: (fail: any) => Promise.resolve().then(() => resolve(spec)).catch(fail),
  };
  return chain;
}

const keys: any[] = [];

const PersonalAccessToken: any = {
  create: jest.fn(async (doc: any) => {
    const rec = {
      _id: new Types.ObjectId(),
      // Schema defaults the real collection applies.
      revoked: false,
      lastUsedAt: null,
      createdAt: new Date(),
      permissions: undefined,
      ipAllowlist: undefined,
      serviceAccountId: null,
      userId: null,
      ...doc,
    };
    keys.push(rec);
    return rec;
  }),
  find: jest.fn((filter: any) => query((spec) => sortDocs(keys.filter((k) => matches(k, filter)), spec).map((k) => ({ ...k })))),
  findOne: jest.fn((filter: any) => query(() => {
    const hit = keys.find((k) => matches(k, filter));
    return hit ? { ...hit } : null;
  })),
  countDocuments: jest.fn((filter: any) => query(() => keys.filter((k) => matches(k, filter)).length)),
  findOneAndUpdate: jest.fn((filter: any, update: any) => query(() => {
    const hit = keys.find((k) => matches(k, filter));
    if (!hit) return null;
    Object.assign(hit, update.$set ?? {});
    return { ...hit };
  })),
  updateOne: jest.fn((filter: any, update: any) => query(() => {
    const hit = keys.find((k) => matches(k, filter));
    if (hit) Object.assign(hit, update.$set ?? {});
    return { modifiedCount: hit ? 1 : 0 };
  })),
  updateMany: jest.fn((filter: any, update: any) => query(() => {
    const hits = keys.filter((k) => matches(k, filter));
    for (const hit of hits) Object.assign(hit, update.$set ?? {});
    return { modifiedCount: hits.length };
  })),
  deleteMany: jest.fn(async (filter: any) => {
    const doomed = keys.filter((k) => matches(k, filter));
    for (const d of doomed) keys.splice(keys.indexOf(d), 1);
    return { deletedCount: doomed.length };
  }),
};

const users = new Map<string, any>();
const User: any = {
  findById: (id: unknown) => query(() => users.get(String(id)) ?? null),
};

jest.unstable_mockModule('../src/models/index.js', () => ({ PersonalAccessToken, User }));
jest.unstable_mockModule('../src/utils/token.js', () => ({
  hashRefreshToken: (t: string) => `h:${t}`,
  enforceOrgAssurance: jest.fn(async (_u: unknown, _m: unknown, auth: unknown) => auth),
  membershipForOrg: jest.fn(async () => undefined),
  signApiKeyToken: jest.fn(async () => 'jwt'),
  signServiceAccountToken: jest.fn(async () => 'jwt'),
}));

const mockPublishKeyRevocation = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishSessionSlotRevocation: async () => true,
  publishAccessKeyRevocation: (...a: unknown[]) => mockPublishKeyRevocation(...a),
}));

const mockResolveServiceAccount = jest.fn<(...a: unknown[]) => Promise<any>>();
jest.unstable_mockModule('../src/services/service-account-service.js', () => ({
  resolveServiceAccountExchange: (...a: unknown[]) => mockResolveServiceAccount(...a),
  // The REAL limits, so the cap tests assert the shipped numbers.
  MAX_ACTIVE_KEYS_PER_ACCOUNT: 5,
  MAX_KEY_EXPIRES_IN_SECONDS: 365 * 24 * 60 * 60,
}));

const { apiKeyService } = await import('../src/services/api-key-service.js');
const { hashApiKey, generateApiKey } = await import('@pipeline-builder/api-core');
const { PROFILE_PAT_LIMIT, PROFILE_USER_NOT_FOUND } = await import('../src/services/user-errors.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = '651111111111111111111111';
const OTHER_USER = '652222222222222222222222';
const ACCOUNT_ID = '653333333333333333333333';
const OTHER_ACCOUNT = '654444444444444444444444';

const DAY = 86_400;
const auth: SessionAuth = { amr: ['pwd', 'webauthn'], aal: 2 as const, authTime: new Date('2026-09-01T00:00:00.000Z') };

/** Put a key straight into the collection, bypassing the service. */
function seedKey(over: Record<string, any> = {}): any {
  const raw = generateApiKey(over.prefix ?? 'pb_pat');
  const rec = {
    _id: new Types.ObjectId(),
    keyHash: hashApiKey(raw),
    prefix: 'pb_pat',
    last4: raw.slice(-4),
    name: 'seeded',
    scope: null,
    permissions: undefined,
    organizationId: 'org-1',
    ipAllowlist: undefined,
    userId: USER_ID,
    serviceAccountId: null,
    createdUserAgent: null,
    createdIp: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date(Date.now() + 30 * DAY * 1000),
    lastUsedAt: null,
    revoked: false,
    ...over,
  };
  keys.push(rec);
  return { raw, rec };
}

beforeEach(() => {
  jest.clearAllMocks();
  keys.length = 0;
  users.clear();
  users.set(USER_ID, { _id: USER_ID, lastActiveOrgId: { toString: () => 'org-1' } });
  mockResolveServiceAccount.mockResolvedValue({
    ok: true,
    context: { id: ACCOUNT_ID, name: 'deploy-bot', organizationId: 'org-1' },
  });
});

// ---------------------------------------------------------------------------

describe('create — minting a personal key', () => {
  it('returns the RAW key once and stores only its hash', async () => {
    const { key, view } = await apiKeyService.create(USER_ID, { name: 'ci', expiresInSeconds: 30 * DAY }, auth);

    expect(key.startsWith('pb_pat_')).toBe(true);
    // The secret exists exactly once, in this response.
    expect(keys[0].keyHash).toBe(hashApiKey(key));
    expect(JSON.stringify(view)).not.toContain(key);
    expect(view).toMatchObject({
      name: 'ci',
      prefix: 'pb_pat',
      kind: 'personal',
      display: `pb_pat_…${key.slice(-4)}`,
      scope: null,
      permissions: null,
      organizationId: 'org-1',
      ipAllowlist: null,
      revoked: false,
      status: 'active',
      neverUsed: true,
      expiringSoon: false,
      lastUsedAt: null,
    });
  });

  it('stores the creating session\'s assurance, so an exchanged token can never raise it', async () => {
    await apiKeyService.create(USER_ID, { name: 'ci', expiresInSeconds: DAY }, auth);
    expect(keys[0]).toMatchObject({ amr: ['pwd', 'webauthn'], aal: 2, authTime: auth.authTime });
  });

  it('records the creating passkey\'s model, so every exchange re-applies the org\'s authenticator allowlist', async () => {
    await apiKeyService.create(USER_ID, { name: 'ci', expiresInSeconds: DAY }, { ...auth, aaguid: 'aaguid-1' });
    expect(keys[0].aaguid).toBe('aaguid-1');
  });

  it('records the permission SUBSET, the scope, the prefix and where it was created', async () => {
    const { view } = await apiKeyService.create(USER_ID, {
      name: 'scoped',
      expiresInSeconds: DAY,
      scope: 'reporting:ingest' as any,
      permissions: ['pipelines:read'],
      prefix: 'pb_sa',
      client: { userAgent: 'pipeline-manager CLI on macOS', ip: '203.0.113.7' } as any,
    }, auth);

    expect(view).toMatchObject({
      scope: 'reporting:ingest',
      permissions: ['pipelines:read'],
      kind: 'service_account',
      createdFrom: 'pipeline-manager CLI on macOS',
      createdIp: '203.0.113.7',
    });
  });

  it('binds the key to the creator\'s ACTIVE org, and to none when they have no active org', async () => {
    users.set(OTHER_USER, { _id: OTHER_USER, lastActiveOrgId: undefined });
    const mine = await apiKeyService.create(USER_ID, { name: 'a', expiresInSeconds: DAY }, auth);
    const orgless = await apiKeyService.create(OTHER_USER, { name: 'b', expiresInSeconds: DAY }, auth);

    expect(mine.view.organizationId).toBe('org-1');
    expect(orgless.view.organizationId).toBeNull();
  });

  it('refuses to mint for an account that does not exist', async () => {
    await expect(apiKeyService.create(OTHER_USER, { name: 'x', expiresInSeconds: DAY }, auth))
      .rejects.toThrow(PROFILE_USER_NOT_FOUND);
    expect(keys).toHaveLength(0);
  });

  it('enforces the 50 active-key CAP — and counts only keys that are still usable', async () => {
    // A compromised session must not be able to mint thousands of durable
    // credentials.
    for (let i = 0; i < 50; i += 1) seedKey();
    await expect(apiKeyService.create(USER_ID, { name: 'over', expiresInSeconds: DAY }, auth))
      .rejects.toThrow(PROFILE_PAT_LIMIT);

    // Revoked and expired keys occupy no slot.
    keys[0].revoked = true;
    const { view } = await apiKeyService.create(USER_ID, { name: 'room', expiresInSeconds: DAY }, auth);
    expect(view.name).toBe('room');

    keys.length = 0;
    for (let i = 0; i < 50; i += 1) seedKey({ expiresAt: new Date(Date.now() - 1000) });
    await expect(apiKeyService.create(USER_ID, { name: 'fine', expiresInSeconds: DAY }, auth)).resolves.toBeDefined();
  });

  it('counts only the CREATOR\'s keys toward the cap', async () => {
    for (let i = 0; i < 50; i += 1) seedKey({ userId: OTHER_USER });
    await expect(apiKeyService.create(USER_ID, { name: 'mine', expiresInSeconds: DAY }, auth)).resolves.toBeDefined();
  });
});

describe('createForServiceAccount — minting a machine key', () => {
  it('inherits NO human assurance, so the token can never satisfy a step-up', async () => {
    await apiKeyService.createForServiceAccount({
      serviceAccountId: new Types.ObjectId(ACCOUNT_ID), organizationId: 'org-1', name: 'bot', expiresInSeconds: DAY,
    });

    // An empty `amr` at aal 1 is the whole mechanism — a machine authenticated
    // nobody into existence.
    expect(keys[0]).toMatchObject({ amr: [], aal: 1, prefix: 'pb_sa' });
    expect(keys[0].authTime).toBeInstanceOf(Date);
  });

  it('carries the IP allowlist and scope, and reports them on the view', async () => {
    const { key, view } = await apiKeyService.createForServiceAccount({
      serviceAccountId: new Types.ObjectId(ACCOUNT_ID),
      organizationId: 'org-1',
      name: 'bot',
      expiresInSeconds: DAY,
      ipAllowlist: ['203.0.113.0/24'],
      scope: 'registry:push' as any,
      client: { userAgent: 'terraform', ip: '198.51.100.1' } as any,
    });

    expect(key.startsWith('pb_sa_')).toBe(true);
    expect(view).toMatchObject({
      kind: 'service_account',
      serviceAccountId: ACCOUNT_ID,
      ipAllowlist: ['203.0.113.0/24'],
      scope: 'registry:push',
      createdFrom: 'terraform',
    });
  });

  it('reports an EMPTY allowlist as "any address", not as an empty restriction', async () => {
    // Storing `[]` and rendering it as a restriction would read as "no address
    // may use this key" in the UI.
    const { view } = await apiKeyService.createForServiceAccount({
      serviceAccountId: new Types.ObjectId(ACCOUNT_ID), organizationId: 'org-1', name: 'bot', expiresInSeconds: DAY, ipAllowlist: [],
    });
    expect(view.ipAllowlist).toBeNull();
  });
});

describe('list — metadata only, newest first', () => {
  it('returns the user\'s own keys newest first, and never the secret', async () => {
    seedKey({ name: 'oldest', createdAt: new Date('2026-01-01T00:00:00.000Z') });
    seedKey({ name: 'newest', createdAt: new Date('2026-03-01T00:00:00.000Z') });
    seedKey({ name: 'someone else\'s', userId: OTHER_USER });

    const views = await apiKeyService.list(USER_ID);

    expect(views.map((v) => v.name)).toEqual(['newest', 'oldest']);
    expect(JSON.stringify(views)).not.toContain('keyHash');
  });

  it('labels each key active / expired / revoked, and flags the ones worth acting on', async () => {
    seedKey({ name: 'live', createdAt: new Date('2026-04-01T00:00:00.000Z') });
    seedKey({ name: 'soon', createdAt: new Date('2026-03-01T00:00:00.000Z'), expiresAt: new Date(Date.now() + 3 * DAY * 1000) });
    seedKey({ name: 'used', createdAt: new Date('2026-02-01T00:00:00.000Z'), lastUsedAt: new Date('2026-02-02T00:00:00.000Z') });
    seedKey({ name: 'gone', createdAt: new Date('2026-01-02T00:00:00.000Z'), expiresAt: new Date(Date.now() - 1000) });
    seedKey({ name: 'dead', createdAt: new Date('2026-01-01T00:00:00.000Z'), revoked: true });

    const byName = new Map((await apiKeyService.list(USER_ID)).map((v) => [v.name, v]));

    expect(byName.get('live')).toMatchObject({ status: 'active', expiringSoon: false, neverUsed: true });
    expect(byName.get('soon')).toMatchObject({ status: 'active', expiringSoon: true });
    expect(byName.get('used')).toMatchObject({ neverUsed: false, lastUsedAt: '2026-02-02T00:00:00.000Z' });
    // An expired key is never "expiring soon" — there is nothing left to do.
    expect(byName.get('gone')).toMatchObject({ status: 'expired', expiringSoon: false });
    expect(byName.get('dead')).toMatchObject({ status: 'revoked', revoked: true });
  });

  it('lists a service account\'s keys, and several accounts\' in ONE query', async () => {
    seedKey({ prefix: 'pb_sa', userId: null, serviceAccountId: ACCOUNT_ID, name: 'a', createdAt: new Date('2026-01-01') });
    seedKey({ prefix: 'pb_sa', userId: null, serviceAccountId: ACCOUNT_ID, name: 'b', createdAt: new Date('2026-02-01') });
    seedKey({ prefix: 'pb_sa', userId: null, serviceAccountId: OTHER_ACCOUNT, name: 'c' });

    expect((await apiKeyService.listForServiceAccount(ACCOUNT_ID)).map((v) => v.name)).toEqual(['b', 'a']);

    PersonalAccessToken.find.mockClear();
    const byAccount = await apiKeyService.listForServiceAccounts([ACCOUNT_ID, OTHER_ACCOUNT]);
    // One query however many accounts are asked for.
    expect(PersonalAccessToken.find).toHaveBeenCalledTimes(1);
    expect(byAccount.get(ACCOUNT_ID)!.map((v) => v.name)).toEqual(['b', 'a']);
    expect(byAccount.get(OTHER_ACCOUNT)!.map((v) => v.name)).toEqual(['c']);
  });

  it('answers empty for an account with no keys, and never queries for an invalid id', async () => {
    expect(await apiKeyService.listForServiceAccount(ACCOUNT_ID)).toEqual([]);
    PersonalAccessToken.find.mockClear();
    expect(await apiKeyService.listForServiceAccounts(['not-an-id'])).toEqual(new Map());
    expect(PersonalAccessToken.find).not.toHaveBeenCalled();
  });

  it('counts only ACTIVE keys against an account\'s cap, and zero for an invalid id', async () => {
    seedKey({ prefix: 'pb_sa', userId: null, serviceAccountId: ACCOUNT_ID });
    seedKey({ prefix: 'pb_sa', userId: null, serviceAccountId: ACCOUNT_ID, revoked: true });
    seedKey({ prefix: 'pb_sa', userId: null, serviceAccountId: ACCOUNT_ID, expiresAt: new Date(Date.now() - 1000) });

    expect(await apiKeyService.countActiveForServiceAccount(ACCOUNT_ID)).toBe(1);
    expect(await apiKeyService.countActiveForServiceAccount('nope')).toBe(0);
  });
});

describe('revoke — scoped to the owner', () => {
  it('revokes the user\'s own key and reports it revoked', async () => {
    const { rec } = seedKey();

    const view = await apiKeyService.revoke(USER_ID, String(rec._id));

    expect(view).toMatchObject({ id: String(rec._id), revoked: true, status: 'revoked' });
    expect(keys[0].revokedAt).toBeInstanceOf(Date);
    // Its live exchanged token dies now on every service (`revoke:key:<id>`).
    expect(mockPublishKeyRevocation).toHaveBeenCalledWith(String(rec._id));
  });

  it('REFUSES another user\'s key id — ownership is in the filter, not in a later check', async () => {
    const { rec } = seedKey({ userId: OTHER_USER });
    expect(await apiKeyService.revoke(USER_ID, String(rec._id))).toBeNull();
    expect(keys[0].revoked).toBe(false);
    expect(mockPublishKeyRevocation).not.toHaveBeenCalled();
  });

  it('answers null for an already-revoked key and for a malformed id', async () => {
    const { rec } = seedKey({ revoked: true });
    expect(await apiKeyService.revoke(USER_ID, String(rec._id))).toBeNull();
    expect(await apiKeyService.revoke(USER_ID, 'not-an-id')).toBeNull();
  });

  it('revokes an account\'s key only for that account, and refuses malformed ids', async () => {
    const { rec } = seedKey({ prefix: 'pb_sa', userId: null, serviceAccountId: ACCOUNT_ID });

    expect(await apiKeyService.revokeForServiceAccount(OTHER_ACCOUNT, String(rec._id))).toBeNull();
    expect(await apiKeyService.revokeForServiceAccount(ACCOUNT_ID, 'nope')).toBeNull();
    expect(await apiKeyService.revokeForServiceAccount('nope', String(rec._id))).toBeNull();

    const view = await apiKeyService.revokeForServiceAccount(ACCOUNT_ID, String(rec._id));
    expect(view).toMatchObject({ revoked: true, kind: 'service_account' });
  });

  it('tears down every key of the named accounts, and nobody else\'s', async () => {
    seedKey({ prefix: 'pb_sa', userId: null, serviceAccountId: ACCOUNT_ID });
    seedKey({ prefix: 'pb_sa', userId: null, serviceAccountId: ACCOUNT_ID });
    seedKey({ prefix: 'pb_sa', userId: null, serviceAccountId: OTHER_ACCOUNT });

    expect(await apiKeyService.deleteForServiceAccounts([new Types.ObjectId(ACCOUNT_ID)])).toBe(2);
    expect(keys.map((k) => k.serviceAccountId)).toEqual([OTHER_ACCOUNT]);
    expect(await apiKeyService.deleteForServiceAccounts([])).toBe(0);
  });

  it('revokes every LIVE key a user holds, leaving other users untouched', async () => {
    seedKey();
    seedKey({ revoked: true });
    seedKey({ userId: OTHER_USER });

    const live = seedKey();
    await apiKeyService.revokeAllForUser(USER_ID);

    expect(keys.map((k) => k.revoked)).toEqual([true, true, false, true]);
    // Only the keys that were LIVE are published.
    expect(mockPublishKeyRevocation).toHaveBeenCalledWith([String(keys[0]._id), String(live.rec._id)]);
  });
});

describe('rotateServiceAccountKey — a credential replacing itself', () => {
  const sa = (over: Record<string, any> = {}) => seedKey({
    prefix: 'pb_sa',
    userId: null,
    serviceAccountId: ACCOUNT_ID,
    createdAt: new Date(Date.now() - 10 * DAY * 1000),
    expiresAt: new Date(Date.now() + 20 * DAY * 1000),
    ...over,
  });

  it('mints a SIBLING, leaves the presented key live, and inherits its scope, allowlist and lifetime', async () => {
    const { raw, rec } = sa({ scope: 'registry:push', ipAllowlist: ['203.0.113.0/24'], name: 'deploy' });

    const result = await apiKeyService.rotateServiceAccountKey(raw, {}, '203.0.113.7');

    expect(result.ok).toBe(true);
    const ok = result as any;
    expect(ok.key.startsWith('pb_sa_')).toBe(true);
    expect(ok.previousKeyId).toBe(String(rec._id));
    expect(ok.prunedKeyIds).toEqual([]);
    // The ordering the whole design rests on: store the replacement first, then
    // retire the old one. A rotation that revoked here could strand the caller.
    expect(keys.find((k) => String(k._id) === String(rec._id)).revoked).toBe(false);
    // A rotation can never WIDEN authority.
    expect(ok.view).toMatchObject({ scope: 'registry:push', ipAllowlist: ['203.0.113.0/24'], name: 'deploy' });
    // ~30 days: the replaced key's original lifetime, not a fresh default.
    const lifetime = Math.round((new Date(ok.view.expiresAt).getTime() - Date.now()) / 1000);
    expect(lifetime).toBeGreaterThan(29 * DAY);
    expect(lifetime).toBeLessThanOrEqual(30 * DAY);
  });

  it('honours an explicit name and lifetime', async () => {
    const { raw } = sa();
    const ok = await apiKeyService.rotateServiceAccountKey(raw, { name: 'renamed', expiresInSeconds: 3600 }) as any;
    expect(ok.view.name).toBe('renamed');
    expect(Math.round((new Date(ok.view.expiresAt).getTime() - Date.now()) / 1000)).toBeCloseTo(3600, -2);
  });

  it('refuses a lifetime outside the 60s–365d range, and one that cannot be parsed', async () => {
    const { raw } = sa();
    expect(await apiKeyService.rotateServiceAccountKey(raw, { expiresInSeconds: 30 })).toEqual({ ok: false, reason: 'expiry_invalid' });
    expect(await apiKeyService.rotateServiceAccountKey(raw, { expiresInSeconds: 400 * DAY })).toEqual({ ok: false, reason: 'expiry_invalid' });
    expect(await apiKeyService.rotateServiceAccountKey(raw, { expiresInSeconds: Number.NaN })).toEqual({ ok: false, reason: 'expiry_invalid' });
  });

  it('REFUSES a person\'s key — self-rotation would be a step-up bypass', async () => {
    // A person's key is managed in the UI behind step-up; a machine has no
    // browser and no password, which is the only reason this path exists.
    const { raw } = seedKey();
    expect(await apiKeyService.rotateServiceAccountKey(raw)).toEqual({ ok: false, reason: 'not_service_account' });
  });

  it('refuses a malformed, unknown, revoked, expired or orphaned presented key', async () => {
    expect(await apiKeyService.rotateServiceAccountKey('nonsense')).toEqual({ ok: false, reason: 'malformed' });
    expect(await apiKeyService.rotateServiceAccountKey(generateApiKey('pb_sa'))).toEqual({ ok: false, reason: 'unknown' });
    expect(await apiKeyService.rotateServiceAccountKey(sa({ revoked: true }).raw)).toEqual({ ok: false, reason: 'revoked' });
    expect(await apiKeyService.rotateServiceAccountKey(sa({ expiresAt: new Date(Date.now() - 1000) }).raw))
      .toEqual({ ok: false, reason: 'expired' });
    expect(await apiKeyService.rotateServiceAccountKey(sa({ serviceAccountId: null }).raw)).toEqual({ ok: false, reason: 'orphan_key' });
  });

  it('stops at the account gate — a disabled account, dead org, bad address or spent budget', async () => {
    const { raw } = sa({ ipAllowlist: ['203.0.113.0/24'] });
    mockResolveServiceAccount.mockResolvedValue({ ok: false, reason: 'ip_not_allowed' });

    expect(await apiKeyService.rotateServiceAccountKey(raw, {}, '198.51.100.9')).toEqual({ ok: false, reason: 'ip_not_allowed' });
    expect(mockResolveServiceAccount).toHaveBeenCalledWith(ACCOUNT_ID, '198.51.100.9', ['203.0.113.0/24']);
    // Nothing was minted.
    expect(keys).toHaveLength(1);
  });

  it('PRUNES the oldest PREDECESSOR at the cap — never the key being presented', async () => {
    const siblings = [1, 2, 3, 4].map((n) => sa({ createdAt: new Date(`2026-0${n}-01T00:00:00.000Z`), name: `sib${n}` }));
    const { raw, rec } = sa({ createdAt: new Date('2026-05-01T00:00:00.000Z'), name: 'presented' });

    const ok = await apiKeyService.rotateServiceAccountKey(raw) as any;

    expect(ok.prunedKeyIds).toEqual([String(siblings[0].rec._id)]);
    expect(keys.find((k) => String(k._id) === String(rec._id)).revoked).toBe(false);
    expect(siblings[0].rec.revoked).toBe(true);
  });

  it('never prunes a sibling NEWER than the presented key — a stale key cannot clear out its successors', async () => {
    const { raw, rec } = sa({ createdAt: new Date('2026-01-01T00:00:00.000Z'), name: 'stale' });
    const newer = [2, 3, 4, 5].map((n) => sa({ createdAt: new Date(`2026-0${n}-01T00:00:00.000Z`), name: `sib${n}` }));

    expect(await apiKeyService.rotateServiceAccountKey(raw)).toEqual({ ok: false, reason: 'key_limit' });
    expect(rec.revoked).toBe(false);
    expect(newer.every((s) => s.rec.revoked === false)).toBe(true);
  });

  it('REFUSES a successor that would outlive the presented key\'s own lifetime', async () => {
    // A leaked 30-day key must not be able to mint itself a 365-day successor.
    const { raw } = sa();
    expect(await apiKeyService.rotateServiceAccountKey(raw, { expiresInSeconds: 60 * DAY })).toEqual({ ok: false, reason: 'expiry_invalid' });
    expect(keys.filter((k) => k.prefix === 'pb_sa')).toHaveLength(1);
  });

  it('refuses rather than orphaning the caller when the ONLY active key is the presented one', async () => {
    const { raw, rec } = sa();
    // At the cap with nothing but the presented key active: retiring it would
    // leave the rotator holding a dead credential, so the rotation is refused
    // instead. (The account's live set is what the loop reads; a duplicate
    // reply is the cheapest way to stand one at the cap.)
    PersonalAccessToken.find.mockImplementationOnce(() => query(() => Array.from({ length: 5 }, () => ({ _id: rec._id }))));

    expect(await apiKeyService.rotateServiceAccountKey(raw)).toEqual({ ok: false, reason: 'key_limit' });
    expect(rec.revoked).toBe(false);
  });
});

describe('revokeSiblingKey — the second half of a rotation', () => {
  const sa = (over: Record<string, any> = {}) => seedKey({
    prefix: 'pb_sa', userId: null, serviceAccountId: ACCOUNT_ID, ...over,
  });

  it('retires a sibling using the live replacement', async () => {
    const { raw } = sa({ name: 'new', createdAt: new Date('2026-02-01T00:00:00.000Z') });
    const old = sa({ name: 'old' });

    const result = await apiKeyService.revokeSiblingKey(raw, String(old.rec._id), '203.0.113.7') as any;

    expect(result).toMatchObject({
      ok: true,
      revokedKeyId: String(old.rec._id),
      alreadyRevoked: false,
      serviceAccountId: ACCOUNT_ID,
      serviceAccountName: 'deploy-bot',
      organizationId: 'org-1',
    });
    expect(old.rec.revoked).toBe(true);
  });

  it('REFUSES to revoke a sibling NEWER than the presented key', async () => {
    // Only a key's predecessors are its to retire: the replacement retires the
    // key it replaced, never a sibling issued after it.
    const { raw } = sa({ name: 'old' });
    const newer = sa({ name: 'newer', createdAt: new Date('2026-03-01T00:00:00.000Z') });
    expect(await apiKeyService.revokeSiblingKey(raw, String(newer.rec._id))).toEqual({ ok: false, reason: 'newer_sibling' });
    expect(newer.rec.revoked).toBe(false);
  });

  it('REFUSES to revoke the presented key itself', async () => {
    // The caller must always be left holding a working credential.
    const { raw, rec } = sa();
    expect(await apiKeyService.revokeSiblingKey(raw, String(rec._id))).toEqual({ ok: false, reason: 'self_revoke' });
    expect(rec.revoked).toBe(false);
  });

  it('is IDEMPOTENT: an already-revoked sibling, and another account\'s key, are success with `alreadyRevoked`', async () => {
    const { raw } = sa({ createdAt: new Date('2026-02-01T00:00:00.000Z') });
    const dead = sa({ revoked: true });
    const foreign = sa({ serviceAccountId: OTHER_ACCOUNT });

    expect(await apiKeyService.revokeSiblingKey(raw, String(dead.rec._id)) as any).toMatchObject({ ok: true, alreadyRevoked: true });
    // Not this account's key: the end state ("that key cannot be exchanged by
    // me") holds either way, and a retrying rotator must not see a failure.
    expect(await apiKeyService.revokeSiblingKey(raw, String(foreign.rec._id)) as any).toMatchObject({ ok: true, alreadyRevoked: true });
    expect(foreign.rec.revoked).toBe(false);
  });

  it('refuses a malformed key id, a personal presented key, and a failed account gate', async () => {
    const { raw } = sa();
    expect(await apiKeyService.revokeSiblingKey(raw, 'not-an-id')).toEqual({ ok: false, reason: 'unknown' });
    expect(await apiKeyService.revokeSiblingKey(seedKey().raw, String(sa().rec._id))).toEqual({ ok: false, reason: 'not_service_account' });

    mockResolveServiceAccount.mockResolvedValue({ ok: false, reason: 'account_disabled' });
    expect(await apiKeyService.revokeSiblingKey(raw, String(sa().rec._id))).toEqual({ ok: false, reason: 'account_disabled' });
  });
});

describe('view rendering tolerates what the driver actually hands back', () => {
  it('renders timestamps that arrive as ISO STRINGS rather than Date objects', async () => {
    // A `lean()` read through some driver/BSON paths yields strings; rendering
    // `Invalid Date` here would break the whole keys page.
    seedKey({
      name: 'stringly',
      createdAt: '2026-01-01T00:00:00.000Z' as unknown as Date,
      expiresAt: new Date(Date.now() + 30 * DAY * 1000).toISOString() as unknown as Date,
    });

    const [view] = await apiKeyService.list(USER_ID);

    expect(view.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(view.status).toBe('active');
    expect(Date.parse(view.expiresAt)).not.toBeNaN();
  });

  it('reports zero deletions when the driver answers without a count', async () => {
    PersonalAccessToken.deleteMany.mockResolvedValueOnce({} as never);
    expect(await apiKeyService.deleteForServiceAccounts([new Types.ObjectId(ACCOUNT_ID)])).toBe(0);
  });
});
