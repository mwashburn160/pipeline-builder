// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The cross-request write pin (src/api/write-pin.ts).
 *
 * WHAT IS ACTUALLY AT RISK HERE, and why these are mostly failure-path tests:
 * this module decides whether a request is allowed to read from a replica. Get
 * that wrong in the permissive direction and a user who just created something
 * does not see it — no error, no retry, and not reproducible on demand, which
 * is the single failure the whole read-split feature exists to avoid causing.
 *
 * So every uncertain answer must resolve to "assume this org wrote", which
 * routes reads to the primary. There are four ways to be uncertain — no Redis
 * configured, an unreachable Redis, a rejected read, and no org to key on — and
 * each one has a case below. A test suite for this module that only covered the
 * happy path would be close to worthless.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

/**
 * The ioredis stand-in. Swapped per test to drive each failure mode.
 *
 * Typed rather than `Record<string, unknown>` + `as jest.Mock` casts: a bare
 * `jest.Mock` has no parameter types, so `mockResolvedValue(0)` infers `never`
 * and fails `typecheck:tests` — which the build runs separately from
 * `tsc -p tsconfig.json`, so jest passing proves nothing about it.
 */
interface FakeRedis {
  exists: jest.Mock<(key: string) => Promise<number>>;
  set: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
}
let fakeRedis: FakeRedis | null = null;
const createEnvRedisClient = jest.fn(() => fakeRedis);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createEnvRedisClient,
  // The real gate waits (bounded, never rejecting) for the connection. Resolved
  // immediately here; its behaviour is api-core's to test, not this module's.
  createRedisReadyGate: () => () => Promise.resolve(),
}));

const {
  createEnvRedisWritePinStore, getWritePinStore, setWritePinStore,
  applyWritePin, recordWriteForPin, writePinActive, NO_WRITE_PIN,
} = await import('../src/api/write-pin.js');

/** Same shape as the inner helper, for the suites outside that describe. */
const okRedisOuter = (): FakeRedis => ({
  exists: jest.fn<(key: string) => Promise<number>>().mockResolvedValue(1),
  set: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue('OK'),
});

const ENV = ['DB_READ_HOST', 'DB_READ_ENABLED', 'DB_READ_WRITE_PIN_TTL_SECONDS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  // A replica IS configured for most of these: with none, every entry point
  // short-circuits and there is nothing to exercise.
  process.env.DB_READ_HOST = 'pgbouncer';
  delete process.env.DB_READ_ENABLED;
  createEnvRedisClient.mockClear();
  fakeRedis = null;
  setWritePinStore(undefined);
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setWritePinStore(undefined);
});

describe('writePinActive', () => {
  it('is false with no replica configured, which is how every target ships', () => {
    delete process.env.DB_READ_HOST;
    expect(writePinActive()).toBe(false);
  });

  it('is false when the kill switch is off even with a host set', () => {
    process.env.DB_READ_ENABLED = 'false';
    expect(writePinActive()).toBe(false);
  });

  it('is true once a replica is configured', () => {
    expect(writePinActive()).toBe(true);
  });
});

describe('the Redis-backed store', () => {
  const okRedis = (): FakeRedis => ({
    exists: jest.fn<(key: string) => Promise<number>>().mockResolvedValue(1),
    set: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue('OK'),
  });

  it('reports pinned when the key exists', async () => {
    fakeRedis = okRedis();
    const store = createEnvRedisWritePinStore();
    await expect(store.isPinned('acme')).resolves.toBe(true);
    expect(fakeRedis!.exists).toHaveBeenCalledWith('rw-pin:acme');
  });

  it('reports NOT pinned when the key is absent', async () => {
    // The only path that permits a replica read. If this ever returned true by
    // accident the feature would be inert with none of its cost removed, and
    // nothing would report a fault.
    const r = okRedis();
    r.exists.mockResolvedValue(0);
    fakeRedis = r;
    await expect(createEnvRedisWritePinStore().isPinned('acme')).resolves.toBe(false);
  });

  it('sets the key with the configured TTL', async () => {
    process.env.DB_READ_WRITE_PIN_TTL_SECONDS = '42';
    fakeRedis = okRedis();
    await createEnvRedisWritePinStore().pin('acme');
    expect(fakeRedis!.set).toHaveBeenCalledWith('rw-pin:acme', '1', 'EX', 42);
  });

  it('defaults the TTL to 10s', async () => {
    delete process.env.DB_READ_WRITE_PIN_TTL_SECONDS;
    fakeRedis = okRedis();
    await createEnvRedisWritePinStore().pin('acme');
    expect(fakeRedis!.set).toHaveBeenCalledWith('rw-pin:acme', '1', 'EX', 10);
  });

  it('keys per ORG, not per user', async () => {
    // Deliberate coarseness: a user may read through a different session than
    // the one that wrote, so a per-user key would miss exactly the case the pin
    // exists for. The cost is that one member's write briefly sends the whole
    // org's reads to the primary — which can only remove a benefit, never
    // introduce a regression, because the primary is where they read today.
    fakeRedis = okRedis();
    await createEnvRedisWritePinStore().pin('acme');
    const key = fakeRedis!.set.mock.calls[0][0] as string;
    expect(key).toBe('rw-pin:acme');
  });

  it('builds the client once and reuses it', async () => {
    fakeRedis = okRedis();
    const store = createEnvRedisWritePinStore();
    await store.isPinned('a');
    await store.isPinned('b');
    await store.pin('c');
    expect(createEnvRedisClient).toHaveBeenCalledTimes(1);
  });

  // ---- the four ways to be uncertain, all of which must fail CLOSED ----

  it('fails closed when Redis is not configured at all', async () => {
    fakeRedis = null; // createEnvRedisClient returns null with no REDIS_URL
    await expect(createEnvRedisWritePinStore().isPinned('acme')).resolves.toBe(true);
  });

  it('does not throw when pinning with no Redis', async () => {
    fakeRedis = null;
    await expect(createEnvRedisWritePinStore().pin('acme')).resolves.toBeUndefined();
  });

  it('fails closed when the lookup rejects', async () => {
    const r = okRedis();
    r.exists.mockRejectedValue(new Error('connection reset'));
    fakeRedis = r;
    await expect(createEnvRedisWritePinStore().isPinned('acme')).resolves.toBe(true);
  });

  it('swallows a failed pin rather than failing a request whose write committed', async () => {
    // This is the dangerous direction — the NEXT request may read a stale
    // replica — but throwing here would fail a request whose write has already
    // committed, which is strictly worse. It is logged instead.
    const r = okRedis();
    r.set.mockRejectedValue(new Error('connection reset'));
    fakeRedis = r;
    await expect(createEnvRedisWritePinStore().pin('acme')).resolves.toBeUndefined();
  });

  it('fails closed with no org to key on', async () => {
    // TenantContext.orgId is optional — undefined for unauthenticated requests
    // and system jobs. There is no key, so there is no answer, so: primary.
    fakeRedis = okRedis();
    await expect(createEnvRedisWritePinStore().isPinned(undefined)).resolves.toBe(true);
    await expect(createEnvRedisWritePinStore().isPinned('')).resolves.toBe(true);
    // ...and nothing is written for a scope that cannot be keyed.
    await createEnvRedisWritePinStore().pin(undefined);
    expect(fakeRedis!.set).not.toHaveBeenCalled();
  });
});

describe('the process-wide store', () => {
  it('is built lazily and memoized', () => {
    fakeRedis = okRedisOuter();
    expect(getWritePinStore()).toBe(getWritePinStore());
  });

  it('can be replaced, and reset back to the lazy default', () => {
    setWritePinStore(NO_WRITE_PIN);
    expect(getWritePinStore()).toBe(NO_WRITE_PIN);
    setWritePinStore(undefined);
    expect(getWritePinStore()).not.toBe(NO_WRITE_PIN);
  });

  it('NO_WRITE_PIN reports nothing pinned', async () => {
    await expect(NO_WRITE_PIN.isPinned('acme')).resolves.toBe(false);
    await expect(NO_WRITE_PIN.pin('acme')).resolves.toBeUndefined();
  });
});

describe('applyWritePin', () => {
  it('does nothing at all with no replica configured', async () => {
    delete process.env.DB_READ_HOST;
    setWritePinStore({ isPinned: () => Promise.resolve(true), pin: () => Promise.resolve() });
    const scope = { orgId: 'acme', isSuperAdmin: false };
    await applyWritePin(scope);
    // Not even consulted: with no replica every read is on the primary anyway,
    // so touching Redis on the request path would be pure cost.
    expect(scope).toEqual({ orgId: 'acme', isSuperAdmin: false });
  });

  it('marks the scope when the org is pinned', async () => {
    setWritePinStore({ isPinned: () => Promise.resolve(true), pin: () => Promise.resolve() });
    const scope: { orgId: string; isSuperAdmin: boolean; mayHaveWritten?: boolean } = { orgId: 'acme', isSuperAdmin: false };
    await applyWritePin(scope);
    // The SAME flag withTenantTx sets, so the cross-request case reuses the
    // intra-request mechanism exactly rather than adding a second one.
    expect(scope.mayHaveWritten).toBe(true);
  });

  it('leaves an unpinned scope alone', async () => {
    setWritePinStore({ isPinned: () => Promise.resolve(false), pin: () => Promise.resolve() });
    const scope: { orgId: string; isSuperAdmin: boolean; mayHaveWritten?: boolean } = { orgId: 'acme', isSuperAdmin: false };
    await applyWritePin(scope);
    expect(scope.mayHaveWritten).toBeUndefined();
  });

  it('does not re-check a scope already known to have written', async () => {
    const isPinned = jest.fn<() => Promise<boolean>>().mockResolvedValue(false);
    setWritePinStore({ isPinned, pin: () => Promise.resolve() });
    const scope = { orgId: 'acme', isSuperAdmin: false, mayHaveWritten: true };
    await applyWritePin(scope);
    // Already true; a lookup could only answer "false" and must never be able
    // to CLEAR the flag a real write set.
    expect(isPinned).not.toHaveBeenCalled();
    expect(scope.mayHaveWritten).toBe(true);
  });
});

describe('recordWriteForPin', () => {
  it('pins after a request that may have written', () => {
    const pin = jest.fn<(orgId: string | undefined) => Promise<void>>().mockResolvedValue(undefined);
    setWritePinStore({ isPinned: () => Promise.resolve(false), pin });
    recordWriteForPin({ orgId: 'acme', isSuperAdmin: false, mayHaveWritten: true });
    expect(pin).toHaveBeenCalledWith('acme');
  });

  it('does NOT pin after a read-only request', () => {
    // THE BUG THIS GUARDS, which would defeat the feature rather than break it
    // visibly. withTenantTxRead falls back to the primary via withTenantTx, and
    // if that path marked the request as written, every READ-ONLY request would
    // pin its whole org for the TTL — permanently, since reads fall back
    // whenever no replica is configured. Full complexity, zero offload, no
    // fault reported anywhere.
    const pin = jest.fn<(orgId: string | undefined) => Promise<void>>().mockResolvedValue(undefined);
    setWritePinStore({ isPinned: () => Promise.resolve(false), pin });
    recordWriteForPin({ orgId: 'acme', isSuperAdmin: false });
    expect(pin).not.toHaveBeenCalled();
  });

  it('does nothing with no replica configured', () => {
    delete process.env.DB_READ_HOST;
    const pin = jest.fn<(orgId: string | undefined) => Promise<void>>().mockResolvedValue(undefined);
    setWritePinStore({ isPinned: () => Promise.resolve(false), pin });
    recordWriteForPin({ orgId: 'acme', isSuperAdmin: false, mayHaveWritten: true });
    expect(pin).not.toHaveBeenCalled();
  });
});
