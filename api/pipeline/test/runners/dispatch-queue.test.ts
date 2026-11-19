// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The BullMQ adapter (jobId = requestId, retry = the same job moved to delayed) and the boot wiring. */

import { jest, describe, expect, it, afterEach } from '@jest/globals';

class DelayedError extends Error {}
const added: unknown[][] = [];
const workers: Array<{ name: string; opts: Record<string, unknown>; on: jest.Mock; close: jest.Mock }> = [];
jest.unstable_mockModule('bullmq', () => ({
  DelayedError,
  Queue: class { add = async (...a: unknown[]) => { added.push(a); }; close = jest.fn(async () => undefined); constructor(public name: string) {} },
  Worker: class {
    on = jest.fn(); close = jest.fn(async () => undefined);
    constructor(public name: string, _p: unknown, public opts: Record<string, unknown>) { workers.push(this as never); }
  },
}));

const { bullDispatchQueue, dispatchProcessor, inProcessDispatchQueue, startRunnerDispatch, RUNNER_DISPATCH_QUEUE } = await import('../../src/runners/dispatch-queue.js');
const { setRunnerDepsForTesting } = await import('../../src/runners/deps.js');
const { ORG, PIPE, reply, runnerRow, testDeps } = await import('../helpers/runner-fakes.js');

afterEach(() => { setRunnerDepsForTesting(null); });

describe('bullDispatchQueue', () => {
  it('adds one job per request, jobId = requestId, removed once done', async () => {
    const add = jest.fn(async (..._a: unknown[]) => undefined);
    await bullDispatchQueue({ add } as never).enqueue('req-1');
    await bullDispatchQueue({ add } as never).enqueue('req-2', 5_000);
    expect(add).toHaveBeenNthCalledWith(1, 'deliver', { requestId: 'req-1' }, { jobId: 'req-1', removeOnComplete: true, removeOnFail: true, attempts: 1 });
    expect(add).toHaveBeenNthCalledWith(2, 'deliver', { requestId: 'req-2' }, expect.objectContaining({ jobId: 'req-2', delay: 5_000 }));
  });
});

async function seed() {
  const deps = testDeps();
  const r = runnerRow(); deps.store.runners.set(r.id, r);
  const q = await deps.store.insertRequest({ orgId: ORG, pipelineId: PIPE, action: 'start', requestedBy: 'u', requestedAt: new Date(deps.clock.t), expiresAt: new Date(deps.clock.t + 600_000), runnerId: r.id });
  return { deps, q };
}

describe('dispatchProcessor', () => {
  it('a retry moves the SAME job to delayed and throws DelayedError', async () => {
    const { deps, q } = await seed();
    deps.fetchMock.mockResolvedValue(reply(503, {}));
    const moveToDelayed = jest.fn(async (..._a: unknown[]) => undefined);
    await expect(dispatchProcessor(() => deps)({ data: { requestId: q.id }, moveToDelayed } as never, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledWith(deps.clock.t + 1000, 'tok');
  });

  it('a finished delivery completes the job', async () => {
    const { deps, q } = await seed();
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'started' }));
    const moveToDelayed = jest.fn();
    await dispatchProcessor(() => deps)({ data: { requestId: q.id }, moveToDelayed } as never);
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(deps.store.requests.get(q.id)!.status).toBe('started');
  });
});

describe('inProcessDispatchQueue (no Redis)', () => {
  it('runs the delivery on a timer, re-scheduling a retry, de-duplicating a waiting id', async () => {
    const { deps, q } = await seed();
    const timers: Array<[() => void, number]> = [];
    const queue = inProcessDispatchQueue(() => deps, (fn, ms) => { timers.push([fn, ms]); });
    await queue.enqueue(q.id);
    await queue.enqueue(q.id);
    expect(timers).toHaveLength(1);
    deps.fetchMock.mockResolvedValueOnce(reply(503, {}));
    timers.shift()![0]();
    await new Promise((r) => setTimeout(r, 10));
    expect(timers).toEqual([[expect.any(Function), 1000]]);
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'started' }));
    deps.clock.t += 1000;
    timers.shift()![0]();
    await new Promise((r) => setTimeout(r, 10));
    expect(deps.store.requests.get(q.id)!.status).toBe('started');
  });
});

describe('startRunnerDispatch', () => {
  it('is a no-op while runners are unavailable (no runner signing key)', async () => {
    delete process.env.RUNNER_SIGNING_KEY;
    delete process.env.RUNNER_SIGNING_KEY_FILE;
    const handle = startRunnerDispatch();
    await handle.stop();
    expect(workers).toHaveLength(0);
  });

  it('with Redis: a worker on `runner-dispatch` at RUNNER_DISPATCH_CONCURRENCY', async () => {
    setRunnerDepsForTesting(testDeps());
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    process.env.RUNNER_DISPATCH_CONCURRENCY = '3';
    try {
      const handle = startRunnerDispatch();
      expect(workers[0]).toMatchObject({ name: RUNNER_DISPATCH_QUEUE, opts: expect.objectContaining({ concurrency: 3 }) });
      await handle.stop();
      expect(workers[0]!.close).toHaveBeenCalled();
    } finally {
      delete process.env.REDIS_URL;
      delete process.env.RUNNER_DISPATCH_CONCURRENCY;
    }
  });

  it('without Redis: in-process dispatch', async () => {
    setRunnerDepsForTesting(testDeps());
    const before = workers.length;
    const handle = startRunnerDispatch();
    expect(workers.length).toBe(before);
    await handle.stop();
  });
});
