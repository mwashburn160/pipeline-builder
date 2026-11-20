// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The leader-locked sweep drives the signing-key lifecycle: promote, retire,
 * transitions and age reminders run every cycle (even while deliveries are
 * paused), each isolated from the others' failures. The dispatcher no longer
 * re-checks any per-org feature.
 */

import { jest, describe, expect, it, beforeEach } from '@jest/globals';

const calls: string[] = [];
const step = (name: string) => jest.fn(async (_deps: unknown, now?: Date) => { calls.push(`${name}@${now?.toISOString()}`); });
const mockPromote = step('promote');
const mockRetire = step('retire');
const mockAdvance = step('advance');
const mockRemind = step('remind');
jest.unstable_mockModule('../../src/runners/keys.js', () => ({
  promoteDueKeys: mockPromote,
  retireDueKeys: mockRetire,
  advanceKeyTransitions: mockAdvance,
  sendKeyAgeReminders: mockRemind,
}));

const { processDelivery, runSweep } = await import('../../src/runners/lifecycle.js');
const { runnerSweepOptions } = await import('../../src/runners/dispatch-queue.js');
const { ORG, PIPE, reply, runnerRow, testDeps } = await import('../helpers/runner-fakes.js');

beforeEach(() => { calls.length = 0; jest.clearAllMocks(); });

describe('the sweep runs the signing-key lifecycle', () => {
  it('calls promote, retire, transitions and age reminders, in that order, with the sweep\'s clock', async () => {
    const deps = testDeps();
    await runSweep(deps);
    const at = new Date(deps.clock.t).toISOString();
    expect(calls).toEqual([`promote@${at}`, `retire@${at}`, `advance@${at}`, `remind@${at}`]);
    for (const m of [mockPromote, mockRetire, mockAdvance, mockRemind]) expect(m).toHaveBeenCalledWith(deps, expect.any(Date));
  });

  it('one failing step neither stops the others nor the rest of the sweep', async () => {
    const deps = testDeps();
    mockRetire.mockRejectedValueOnce(new Error('db down'));
    const r = runnerRow(); deps.store.runners.set(r.id, r);
    const counts = await runSweep(deps);
    expect(mockAdvance).toHaveBeenCalled();
    expect(mockRemind).toHaveBeenCalled();
    expect(counts.pinged).toBe(1);
  });

  it('runs while deliveries are paused (a rotation keeps its schedule), but nothing is pinged or re-kicked', async () => {
    const deps = testDeps();
    deps.availability.available = false;
    deps.availability.reason = 'paused';
    const r = runnerRow(); deps.store.runners.set(r.id, r);
    await deps.store.insertRequest({ orgId: ORG, pipelineId: PIPE, action: 'start', requestedBy: 'u', expiresAt: new Date(deps.clock.t + 600_000), runnerId: r.id });
    expect(await runSweep(deps)).toMatchObject({ pinged: 0, rekicked: 0 });
    expect(mockPromote).toHaveBeenCalled();
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it('is the scheduler\'s leader-locked job', async () => {
    const deps = testDeps();
    const opts = runnerSweepOptions(() => deps);
    expect(opts.lock).toMatchObject({ key: expect.stringContaining('runner-sweep') });
    await opts.run({ signal: new AbortController().signal } as never);
    expect(mockPromote).toHaveBeenCalledTimes(1);
  });

  it('a database without the runner tables skips the whole sweep', async () => {
    const deps = testDeps();
    deps.store.tablesPresent = async () => false;
    await runSweep(deps);
    expect(mockPromote).not.toHaveBeenCalled();
  });
});

describe('the dispatcher', () => {
  it('delivers without any per-org feature re-check (runners are a core capability)', async () => {
    const deps = testDeps();
    const r = runnerRow(); deps.store.runners.set(r.id, r);
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'started', executionId: 'e-1' }));
    const q = await deps.store.insertRequest({ orgId: ORG, pipelineId: PIPE, action: 'start', requestedBy: 'u', expiresAt: new Date(deps.clock.t + 600_000), runnerId: r.id });
    expect(await processDelivery(deps, q.id)).toEqual({ done: true });
    expect(deps.store.requests.get(q.id)).toMatchObject({ status: 'started', resultExecutionId: 'e-1' });
    expect(deps.signerOrgs).toEqual([r.orgId]);
  });

  it('leaves the request queued while deliveries are paused (the sweep re-kicks it on resume)', async () => {
    const deps = testDeps();
    const r = runnerRow(); deps.store.runners.set(r.id, r);
    const q = await deps.store.insertRequest({ orgId: ORG, pipelineId: PIPE, action: 'start', requestedBy: 'u', expiresAt: new Date(deps.clock.t + 600_000), runnerId: r.id });
    deps.availability.available = false;
    deps.availability.reason = 'paused';
    expect(await processDelivery(deps, q.id)).toEqual({ done: true });
    expect(deps.store.requests.get(q.id)!.status).toBe('queued');
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });
});
