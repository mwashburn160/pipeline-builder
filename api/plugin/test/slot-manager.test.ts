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

  it('records the owner keyed by the caller-supplied (queue-qualified) id', async () => {
    await tryAcquireOrgSlot('org-a', 'plugin-build-developer:job-1');

    expect(mockHset).toHaveBeenCalledWith(OWNERS_KEY, 'plugin-build-developer:job-1', 'org-a');
  });

  it('does not record an owner when the cap is already reached', async () => {
    mockEval.mockResolvedValueOnce(0); // Lua returns 0 → over cap
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
