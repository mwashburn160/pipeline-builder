// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Small cap so eviction is exercisable without driving thousands of entries.
jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@pipeline-builder/pipeline-core', () => ({
  CoreConstants: {
    IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60000,
    IDEMPOTENCY_TTL_MS: 60000,
    IDEMPOTENCY_MAX_STORE_SIZE: 2,
  },
}));

import { createMemoryStore } from '../src/api/idempotency-middleware';

const entry = (n: number) => ({ statusCode: 200, body: { n }, expiresAt: Date.now() + 60000 });

describe('in-memory idempotency store eviction (bounded, oldest-first)', () => {
  it('evicts the oldest entry at capacity instead of dropping the NEW key', async () => {
    const store = createMemoryStore();
    await store.set('a', entry(1), 60);
    await store.set('b', entry(2), 60);
    await store.set('c', entry(3), 60); // at cap (2) → evict oldest 'a'

    expect(await store.get('a')).toBeNull(); // oldest evicted
    expect(await store.get('b')).not.toBeNull(); // retained
    expect(await store.get('c')).not.toBeNull(); // NEW key still stored (the fix)
  });

  it('overwriting an existing key does not evict another', async () => {
    const store = createMemoryStore();
    await store.set('a', entry(1), 60);
    await store.set('b', entry(2), 60);
    await store.set('a', entry(11), 60); // overwrite — size stays 2, no eviction

    expect(await store.get('b')).not.toBeNull();
    expect((await store.get('a'))?.body).toEqual({ n: 11 });
  });
});
