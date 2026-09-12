// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for queue/slot-manager.
 *
 * Two hardening properties:
 *  (1) the per-org counter TTL is refreshed on EVERY acquire (not just the
 *      0->1 transition), so a continuously-busy org's key can't expire
 *      mid-flight and reset the cap;
 *  (2) the owner hash + the scrubber's live-set are keyed by a
 *      queue-qualified id (`${queueName}:${jobId}`). BullMQ job ids are
 *      per-queue-monotonic, so the per-tier queues mint colliding bare ids;
 *      a bare-id live-set would treat one tier's job as "live" for a same-id
 *      owner recorded from another tier and never reclaim the leak.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// -- Redis + queue mocks (before imports) -------------------------------------

const mockEval = jest.fn<(...args: any[]) => any>().mockResolvedValue(1);
const mockDecr = jest.fn<(...args: any[]) => any>().mockResolvedValue(0);
const mockHset = jest.fn<(...args: any[]) => any>().mockResolvedValue(1);
const mockHdel = jest.fn<(...args: any[]) => any>().mockResolvedValue(1);
const mockHgetall = jest.fn<(...args: any[]) => any>().mockResolvedValue({});
const mockSet = jest.fn<(...args: any[]) => any>().mockResolvedValue('OK');

const redis = {
  eval: mockEval,
  decr: mockDecr,
  hset: mockHset,
  hdel: mockHdel,
  hgetall: mockHgetall,
  set: mockSet,
};

const mockGetAllTierQueues = jest.fn<() => any[]>(() => []);
const mockGetDeadLetterQueue = jest.fn<() => any>(() => ({ name: 'plugin-build-dlq', getJobs: async () => [] }));

// Registered as a function so the NaN-fallback test can re-apply the mocks
// after `jest.resetModules()` and re-import slot-manager with a garbage env.
// NOTE: `env-int.js` is intentionally NOT mocked — the real `intFromEnv` runs
// so the fallback behaviour is exercised end-to-end.
function registerMocks() {
  jest.unstable_mockModule('../src/queue/plugin-build-queue.js', () => ({
    getConnectionForDb: () => redis,
    getAllTierQueues: mockGetAllTierQueues,
  }));

  jest.unstable_mockModule('../src/queue/plugin-build-dlq.js', () => ({
    getDeadLetterQueue: mockGetDeadLetterQueue,
  }));

  jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  }));
}

registerMocks();

const { tryAcquireOrgSlot, scrubOrgSlots } = await import('../src/queue/slot-manager.js');

const OWNERS_KEY = 'pb:org-build-owners';

// -- Tests --------------------------------------------------------------------

describe('tryAcquireOrgSlot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEval.mockResolvedValue(1);
  });

  it('refreshes the counter TTL on EVERY acquire (Lua EXPIRE is unconditional)', async () => {
    await tryAcquireOrgSlot('org-a', 'plugin-build-developer:job-1');

    const lua = String(mockEval.mock.calls[0][0]);
    // EXPIRE is present...
    expect(lua).toMatch(/EXPIRE/);
    // ...and NOT gated behind the 0->1 transition (the old `if count == 1` bug).
    expect(lua).not.toMatch(/count\s*==\s*1/);
  });

  it('records the owner ATOMICALLY with the INCR, keyed by the queue-qualified id', async () => {
    // The HSET used to be a SECOND round trip after the eval. If it threw, the
    // counter was already raised with no owner entry — and the scrubber
    // reclaims by iterating the owner hash, so that slot could only be
    // reclaimed by the 900s TTL, wedging the org's cap until then.
    await tryAcquireOrgSlot('org-a', 'plugin-build-developer:job-1');

    const call = mockEval.mock.calls.at(-1)!;
    // (LUA, numKeys=2, counterKey, ownersKey, cap, ttl, jobId, orgId)
    expect(call[1]).toBe(2);
    expect(call[3]).toBe(OWNERS_KEY);
    expect(call[6]).toBe('plugin-build-developer:job-1');
    expect(call[7]).toBe('org-a');
    // No separate write — the owner record rides the same script.
    expect(mockHset).not.toHaveBeenCalled();
  });

  it('records no owner when the cap is already reached', async () => {
    mockEval.mockResolvedValueOnce(0); // Lua returns 0 → over cap, before the HSET
    const ok = await tryAcquireOrgSlot('org-a', 'plugin-build-developer:job-9');

    expect(ok).toBe(false);
    expect(mockHset).not.toHaveBeenCalled();
  });
});

describe('scrubOrgSlots — queue-qualified reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDecr.mockResolvedValue(0);
  });

  it('reclaims a same-id slot in a different queue (bare-id collision would leak it)', async () => {
    // Two owners share the bare job id "job-1" but live in different tier queues.
    mockHgetall.mockResolvedValueOnce({
      'plugin-build-developer:job-1': 'org-a', // live below
      'plugin-build-pro:job-1': 'org-b', // NOT live → must be reclaimed
    });

    // Only the developer queue actually has job-1 in flight; pro is empty.
    mockGetAllTierQueues.mockReturnValueOnce([
      { tier: 'developer', queue: { name: 'plugin-build-developer', getJobs: async () => [{ id: 'job-1' }] } },
      { tier: 'pro', queue: { name: 'plugin-build-pro', getJobs: async () => [] } },
    ]);
    mockGetDeadLetterQueue.mockReturnValueOnce({ name: 'plugin-build-dlq', getJobs: async () => [] });

    await scrubOrgSlots();

    // org-b's leaked slot reclaimed...
    expect(mockDecr).toHaveBeenCalledWith('pb:org-build:org-b');
    expect(mockHdel).toHaveBeenCalledWith(OWNERS_KEY, 'plugin-build-pro:job-1');
    // ...while the genuinely-live developer:job-1 owner is untouched.
    expect(mockDecr).not.toHaveBeenCalledWith('pb:org-build:org-a');
    expect(mockHdel).not.toHaveBeenCalledWith(OWNERS_KEY, 'plugin-build-developer:job-1');
  });

  it('keeps an owner whose job is live in its own queue', async () => {
    mockHgetall.mockResolvedValueOnce({ 'plugin-build-team:job-5': 'org-c' });
    mockGetAllTierQueues.mockReturnValueOnce([
      { tier: 'team', queue: { name: 'plugin-build-team', getJobs: async () => [{ id: 'job-5' }] } },
    ]);
    mockGetDeadLetterQueue.mockReturnValueOnce({ name: 'plugin-build-dlq', getJobs: async () => [] });

    await scrubOrgSlots();

    expect(mockDecr).not.toHaveBeenCalled();
    expect(mockHdel).not.toHaveBeenCalled();
  });
});

describe('MAX_BUILDS_PER_ORG — NaN-fallback (bricked-builds regression)', () => {
  const KEY = 'PLUGIN_MAX_BUILDS_PER_ORG';
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
    jest.clearAllMocks();
  });

  it('falls back to the default cap (3) instead of passing NaN to the acquire Lua', async () => {
    // A garbage env value previously produced `parseInt('garbage', 10) === NaN`,
    // and `String(NaN)` -> the Lua's `tonumber(ARGV[1])` returns nil, so every
    // acquire would throw and brick ALL plugin builds. intFromEnv must instead
    // fall back to the numeric default.
    process.env[KEY] = 'not-a-number';
    jest.resetModules();
    registerMocks();
    const mod = await import('../src/queue/slot-manager.js');

    mockEval.mockResolvedValueOnce(1);
    const ok = await mod.tryAcquireOrgSlot('org-x', 'plugin-build-developer:job-1');

    expect(ok).toBe(true);
    // eval args: (LUA, numKeys, counterKey, ownersKey, String(cap), String(ttl),
    // jobId, orgId). The cap must be
    // the numeric default, never the string 'NaN'.
    const capArg = mockEval.mock.calls.at(-1)![4];
    expect(capArg).toBe('3');
    expect(capArg).not.toBe('NaN');
  });

  it('honours a valid override', async () => {
    process.env[KEY] = '7';
    jest.resetModules();
    registerMocks();
    const mod = await import('../src/queue/slot-manager.js');

    mockEval.mockResolvedValueOnce(1);
    await mod.tryAcquireOrgSlot('org-x', 'plugin-build-developer:job-2');

    expect(mockEval.mock.calls.at(-1)![4]).toBe('7');
  });
});
