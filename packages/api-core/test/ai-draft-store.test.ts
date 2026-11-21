// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Draft ids for AI-generated drafts: issued per draft, bound to org + user +
 * feature, redeemable exactly once, for about an hour.
 */

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { makeFakeRedis } from './helpers/fake-redis.js';
import { realRedisUrl, redisSuite } from './helpers/redis-gate.js';
import { AI_DRAFT_FEATURES, AI_DRAFT_ID_PATTERN, AI_DRAFT_ID_TTL_MS, AI_DRAFT_OUTCOMES } from '../src/constants/ai-draft.js';
import {
  _setAiDraftStoreForTests,
  createEnvAiDraftStore,
  createMemoryAiDraftStore,
  createRedisAiDraftStore,
  getAiDraftStore,
  issueAiDraftId,
  type AiDraftRef,
  type AiDraftStore,
  type AiDraftStoreConfig,
} from '../src/services/ai-draft-store.js';

const stores: AiDraftStore[] = [];
afterEach(() => { while (stores.length) stores.pop()!.stop(); });

const REF: AiDraftRef = { orgId: 'org-a', userId: 'user-1', feature: 'pipeline-generate' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function contract(name: string, make: (cfg?: AiDraftStoreConfig) => AiDraftStore | Promise<AiDraftStore>): void {
  describe(`AI draft store contract (${name})`, () => {
    const build = async (cfg?: AiDraftStoreConfig) => {
      const s = await make(cfg);
      stores.push(s);
      return s;
    };

    it('issues a well-formed id that redeems once, then answers used', async () => {
      const store = await build();
      const id = await store.issue(REF);
      expect(id).toMatch(AI_DRAFT_ID_PATTERN);
      expect(await store.redeem(id!, REF)).toBe('ok');
      expect(await store.redeem(id!, REF)).toBe('used');
    });

    it('refuses the id for another user or another org (and does not spend it)', async () => {
      const store = await build();
      const id = (await store.issue(REF))!;
      expect(await store.redeem(id, { ...REF, userId: 'user-2' })).toBe('invalid');
      expect(await store.redeem(id, { ...REF, orgId: 'org-b' })).toBe('invalid');
      expect(await store.redeem(id, REF)).toBe('ok');
    });

    it('refuses the id for a feature other than the one that produced it', async () => {
      const store = await build();
      const id = (await store.issue(REF))!;
      expect(await store.redeem(id, { ...REF, feature: 'agent' })).toBe('invalid');
      expect(await store.redeem(id, REF)).toBe('ok');
    });

    it('treats the org case-insensitively (services lower-case it differently)', async () => {
      const store = await build();
      const id = (await store.issue({ ...REF, orgId: 'ORG-A' }))!;
      expect(await store.redeem(id, REF)).toBe('ok');
    });

    it('refuses a forged or malformed id', async () => {
      const store = await build();
      await store.issue(REF);
      expect(await store.redeem('A'.repeat(32), REF)).toBe('invalid');
      expect(await store.redeem('not-a-draft-id', REF)).toBe('invalid');
      expect(await store.redeem('', REF)).toBe('invalid');
    });

    it('refuses an expired id', async () => {
      const store = await build({ ttlMs: 50 });
      const id = (await store.issue(REF))!;
      await sleep(80);
      expect(await store.redeem(id, REF)).toBe('invalid');
    });

    it('issues nothing for a caller with no user', async () => {
      const store = await build();
      expect(await store.issue({ ...REF, userId: '' })).toBeNull();
    });
  });
}

contract('memory', (cfg) => createMemoryAiDraftStore(cfg));
contract('redis (fake)', (cfg) => createRedisAiDraftStore(makeFakeRedis() as never, cfg));

describe('Redis AI draft store specifics', () => {
  it('stores the record under a key binding org + user, with the id TTL', async () => {
    const fake = makeFakeRedis();
    const store = createRedisAiDraftStore(fake as never);
    const before = Date.now();
    const id = (await store.issue({ orgId: 'Org:A', userId: 'u:1', feature: 'agent' }))!;
    const key = `ai-draft:${encodeURIComponent('org:a')}:${encodeURIComponent('u:1')}:${id}`;
    const rec = fake.strings.get(key);
    expect(rec?.value).toBe('agent');
    expect(rec!.expiresAt - before).toBeGreaterThanOrEqual(AI_DRAFT_ID_TTL_MS - 1000);
  });

  it('fails closed when Redis errors: issue returns null, redeem answers unavailable', async () => {
    const boom = async () => { throw new Error('ECONNREFUSED'); };
    const store = createRedisAiDraftStore({ set: boom, eval: boom });
    expect(await store.issue(REF)).toBeNull();
    expect(await store.redeem('A'.repeat(32), REF)).toBe('unavailable');
  });
});

describe('process-wide store', () => {
  afterEach(() => _setAiDraftStoreForTests());

  it('builds the in-memory backend from an env without Redis, once', async () => {
    const saved = { url: process.env.REDIS_URL, sentinels: process.env.REDIS_SENTINELS };
    delete process.env.REDIS_URL;
    delete process.env.REDIS_SENTINELS;
    try {
      const env = createEnvAiDraftStore();
      stores.push(env);
      expect(await env.redeem((await env.issue(REF))!, REF)).toBe('ok');
      expect(getAiDraftStore()).toBe(getAiDraftStore());
      const id = await issueAiDraftId(REF);
      expect(await getAiDraftStore().redeem(id!, REF)).toBe('ok');
    } finally {
      if (saved.url !== undefined) process.env.REDIS_URL = saved.url;
      if (saved.sentinels !== undefined) process.env.REDIS_SENTINELS = saved.sentinels;
    }
  });

  it('issueAiDraftId never throws: a failing store serves the draft without an id', async () => {
    _setAiDraftStoreForTests({ issue: async () => { throw new Error('boom'); }, redeem: async () => 'unavailable', stop: () => undefined });
    expect(await issueAiDraftId(REF)).toBeUndefined();
    _setAiDraftStoreForTests({ issue: async () => null, redeem: async () => 'unavailable', stop: () => undefined });
    expect(await issueAiDraftId(REF)).toBeUndefined();
  });

  it('the memory backend sweeps expired records on its timer', async () => {
    jest.useFakeTimers();
    try {
      const store = createMemoryAiDraftStore({ ttlMs: 1_000 });
      stores.push(store);
      const id = (await store.issue(REF))!;
      jest.advanceTimersByTime(2_500);
      expect(await store.redeem(id, REF)).toBe('invalid');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('AI draft catalog', () => {
  it('pins the two closed catalogs every service shares', () => {
    expect(AI_DRAFT_FEATURES).toEqual(['agent', 'pipeline-generate', 'plugin-generate']);
    expect(AI_DRAFT_OUTCOMES).toEqual(['accepted', 'edited_accepted', 'discarded']);
  });
});

/** Real-Redis check of the redeem script. Opt-in: API_CORE_TEST_REDIS_URL. */
const REAL_URL = realRedisUrl();
redisSuite()('Redis AI draft store (real Redis)', () => {
  const clients: Array<{ quit(): Promise<unknown> }> = [];
  afterEach(async () => { while (clients.length) await clients.pop()!.quit(); });

  it('single use, binding and expiry', async () => {
    const { Redis } = await import('ioredis');
    const client = new Redis(REAL_URL!);
    clients.push(client);
    const store = createRedisAiDraftStore(client as never, { ttlMs: 300 });
    const ref = { ...REF, orgId: `org-${Date.now()}-${Math.random()}` };
    const id = (await store.issue(ref))!;
    expect(await store.redeem(id, { ...ref, userId: 'other' })).toBe('invalid');
    expect(await store.redeem(id, { ...ref, feature: 'agent' })).toBe('invalid');
    expect(await store.redeem(id, ref)).toBe('ok');
    expect(await store.redeem(id, ref)).toBe('used');
    const late = (await store.issue(ref))!;
    await sleep(400);
    expect(await store.redeem(late, ref)).toBe('invalid');
  });
});
