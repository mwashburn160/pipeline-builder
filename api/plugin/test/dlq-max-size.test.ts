// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `enforceDlqMaxSize` — the DLQ capacity valve.
 *
 * It could never evict the jobs that actually fill the DLQ. A DLQ job's
 * processor SUCCEEDS by re-queueing the build onto the main queue, so a
 * re-queued job lands in `completed` with `attemptsMade (1) < maxAttempts (3)`.
 * The old filter required `attemptsMade >= maxAttempts`, so those were excluded
 * — and once `dlqMaxSize` of them were retained, the cap was never enforced
 * again while every retryable failure still paid for a full 5-state scan.
 *
 * The second property here matters just as much: evicting a re-queued job must
 * NOT release its quota slot or clean its build artifacts. The new main-queue
 * job owns both — releasing would free a slot still in use and delete the
 * inputs a live build is about to read.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const releasePluginQuota = jest.fn();
const cleanupBuildArtifacts = jest.fn();

// plugin-build-dlq links against the queue toolkit, so the mocks have to provide
// every name it imports — not just the ones we assert on. Queue handles +
// connections live in connections.js, slot release in build-quota.js, and the
// build context/artifact and build-event helpers in build-workspace.js /
// build-failures.js, so each is mocked at its own specifier.
const dlqQueue = { getJobs: jest.fn<(states: string[]) => Promise<unknown[]>>(), getJobCounts: jest.fn<(...s: string[]) => Promise<Record<string, number>>>(), add: jest.fn(), obliterate: jest.fn<() => Promise<void>>() };
jest.unstable_mockModule('../src/queue/connections.js', () => ({
  DLQ_NAME: 'plugin-build-dlq',
  getBuildCfg: () => ({ dlqMaxSize: 3, dlqMaxAttempts: 3, dlqBackoffBaseMs: 1000, maxAttempts: 2 }),
  getConnectionForDb: () => ({}),
  getDeadLetterQueue: () => dlqQueue,
  totalAttemptBudget: () => 8,
  getTierQueue: jest.fn(),
  getOrgTier: jest.fn(),
}));
jest.unstable_mockModule('../src/queue/build-quota.js', () => ({ releasePluginQuota }));
jest.unstable_mockModule('../src/queue/build-workspace.js', () => ({ cleanupBuildArtifacts, BuildContextMissingError: class extends Error {} }));
jest.unstable_mockModule('../src/queue/build-failures.js', () => ({ recordTerminalFailedBuildEvent: jest.fn(), isFinalAttempt: jest.fn() }));

const getJobs = dlqQueue.getJobs;
const getJobCounts = dlqQueue.getJobCounts;
jest.unstable_mockModule('bullmq', () => ({
  Worker: jest.fn(),
}));
const { enforceDlqMaxSize, purgeDlq } = await import('../src/queue/plugin-build-dlq.js');

const quotaService = {} as never;

/** A DLQ job double. `remove` is spied so we can assert what was purged. */
function job(id: string, opts: { attemptsMade: number; maxAttempts: number; timestamp: number }) {
  return {
    id,
    timestamp: opts.timestamp,
    attemptsMade: opts.attemptsMade,
    opts: { attempts: opts.maxAttempts },
    finishedOn: Date.now(),
    data: { pluginRecord: { name: `plugin-${id}` }, buildRequest: { contextDir: `/tmp/${id}` } },
    remove: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

/** A job that re-queued successfully: completed, still under its attempt cap. */
const requeued = (id: string, ts: number) => job(id, { attemptsMade: 1, maxAttempts: 3, timestamp: ts });
/** A job that exhausted its DLQ retries. */
const terminal = (id: string, ts: number) => job(id, { attemptsMade: 3, maxAttempts: 3, timestamp: ts });

// The enforcer self-throttles on a module-level "last scan" timestamp, so the
// clock must advance past the scan interval BETWEEN tests or every test after
// the first is throttled out. Hold the fake clock explicitly rather than reading
// `Date.now()` inside the spy: that only advanced because the PREVIOUS test's spy
// was still installed when it was read (so each test compounded +10min off the
// last fake value). Under `restoreMocks` the spy is gone by then, `Date.now()`
// returns the real time, and the clock froze — throttling every test but the first.
let fakeClock = Date.now();

beforeEach(async () => {
  jest.clearAllMocks();
  fakeClock += 10 * 60 * 1000;
  jest.spyOn(Date, 'now').mockReturnValue(fakeClock);
});

describe('enforceDlqMaxSize', () => {
  /** Wire the queue state: completed / failed / pending lists. */
  function withJobs(completed: unknown[], failed: unknown[], pending: unknown[]) {
    getJobCounts.mockResolvedValue({
      waiting: pending.length, delayed: 0, active: 0, completed: completed.length, failed: failed.length,
    });
    getJobs.mockImplementation(async (states: string[]) => {
      if (states.includes('completed')) return completed;
      if (states.includes('failed')) return failed;
      return pending;
    });
  }

  it('does nothing while under the cap', async () => {
    const a = requeued('a', 1);
    withJobs([a], [], []);
    await enforceDlqMaxSize(quotaService);
    expect(a.remove).not.toHaveBeenCalled();
  });

  it('REGRESSION: evicts re-queued (completed) jobs, which the old filter never could', async () => {
    // 4 completed re-queued jobs against dlqMaxSize 3. Under the old
    // `attemptsMade >= maxAttempts` filter NONE of these qualified, so the DLQ
    // stayed permanently over cap and every failure paid for a pointless scan.
    const jobs = [requeued('a', 1), requeued('b', 2), requeued('c', 3), requeued('d', 4)];
    withJobs(jobs, [], []);

    await enforceDlqMaxSize(quotaService);

    // Oldest-first: `a` and `b` go (4 - 3 + 1 = 2).
    expect(jobs[0].remove).toHaveBeenCalled();
    expect(jobs[1].remove).toHaveBeenCalled();
    expect(jobs[3].remove).not.toHaveBeenCalled();
  });

  it('does NOT release the slot or artifacts of a re-queued job', async () => {
    // The new main-queue job owns both; releasing here would free a slot still
    // in use and delete the inputs of a live build.
    const jobs = [requeued('a', 1), requeued('b', 2), requeued('c', 3), requeued('d', 4)];
    withJobs(jobs, [], []);

    await enforceDlqMaxSize(quotaService);

    expect(releasePluginQuota).not.toHaveBeenCalled();
    expect(cleanupBuildArtifacts).not.toHaveBeenCalled();
  });

  it('DOES release the slot and artifacts of a terminal failure', async () => {
    // Nothing more will happen to these, so purging must hand both back or the
    // org silently loses build capacity.
    const dead = [terminal('x', 1), terminal('y', 2), terminal('z', 3), terminal('w', 4)];
    withJobs([], dead, []);

    await enforceDlqMaxSize(quotaService);

    expect(releasePluginQuota).toHaveBeenCalled();
    expect(cleanupBuildArtifacts).toHaveBeenCalled();
  });

  it('prefers evicting already-requeued bookkeeping over terminal failures', async () => {
    // Terminal failures still carry recoverable operator context; a re-queued
    // record is pure bookkeeping, so it should go first.
    const req1 = requeued('r1', 1);
    const dead1 = terminal('d1', 0); // older, but still preferred to keep
    withJobs([req1], [dead1], [{}, {}]); // total 4 > cap 3 → purge 2

    await enforceDlqMaxSize(quotaService);

    expect(req1.remove).toHaveBeenCalled();
  });

  it('never evicts waiting/delayed/active jobs — they still have work to do', async () => {
    const pending = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }];
    withJobs([], [], pending);

    await enforceDlqMaxSize(quotaService);

    // Nothing evictable → no releases, and the pending doubles have no `remove`
    // for the enforcer to have called.
    expect(releasePluginQuota).not.toHaveBeenCalled();
  });
});

/**
 * `purgeDlq` — the operator "clear the dead-letter queue" action.
 *
 * It shares the DLQ's central subtlety with `enforceDlqMaxSize` above and used
 * to get it wrong: a `completed` DLQ record means the processor SUCCEEDED in
 * re-queueing the build, so a retry is in flight on the MAIN queue and that new
 * job owns the org's build slot and the build artifacts. `purgeDlq` released
 * both for every job it found, so clearing the DLQ freed slots that were still
 * in use and deleted the inputs live builds were about to read.
 */
describe('purgeDlq', () => {
  beforeEach(() => {
    dlqQueue.obliterate.mockResolvedValue(undefined);
  });

  /** `purgeDlq` fetches the two classes separately; answer per requested state. */
  function withJobs(completed: unknown[], other: unknown[]) {
    getJobs.mockImplementation(async (states: string[]) =>
      (states.includes('completed') ? completed : other));
  }

  it('does NOT release the slot or artifacts of a re-queued job', async () => {
    withJobs([requeued('a', 1)], []);

    await purgeDlq(quotaService);

    expect(releasePluginQuota).not.toHaveBeenCalled();
    expect(cleanupBuildArtifacts).not.toHaveBeenCalled();
    expect(dlqQueue.obliterate).toHaveBeenCalled();
  });

  it('DOES release both for a job that will never run again', async () => {
    // Terminal failures still hold the slot and the artifacts, and nothing else
    // will ever hand them back, so purging must.
    withJobs([], [terminal('b', 2)]);

    await purgeDlq(quotaService);

    expect(releasePluginQuota).toHaveBeenCalledTimes(1);
    expect(cleanupBuildArtifacts).toHaveBeenCalledTimes(1);
  });

  it('counts every purged record, released or not', async () => {
    withJobs([requeued('a', 1)], [terminal('b', 2), terminal('c', 3)]);
    expect(await purgeDlq(quotaService)).toBe(3);
    // ...but only the abandoned two handed anything back.
    expect(releasePluginQuota).toHaveBeenCalledTimes(2);
  });
});
