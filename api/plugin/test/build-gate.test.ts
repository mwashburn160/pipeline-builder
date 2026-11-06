// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-replica build budget's WIRING and its default.
 *
 * The queueing mechanics are api-core's `createConcurrencyGate` (tested there).
 * What matters here is the figure: a replica runs one worker PER TIER, all
 * driving ONE buildkitd sidecar, so its ceiling is the SUM of the ladder — a
 * number nothing declared before this. The incident everyone reasoned about as
 * "8 replicas x 4 = 32" was the single-tier case; the mixed-fleet ceiling is
 * `replicas x the sum`.
 */

import { jest, describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { BUILD_TIER_CONCURRENCY, BUILD_TIER_LADDER, BUILD_LADDER_CONCURRENCY_SUM } from '@pipeline-builder/api-core';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';

const mockIncCounter = jest.fn<AnyFn>();
const mockSetGauge = jest.fn<AnyFn>();
const mockObserve = jest.fn<AnyFn>();
// `stubModule`, not a hand-rolled factory: a factory replaces the WHOLE
// namespace, so any export it omits links as `undefined` and breaks the moment
// production code reaches for it. (The repo's eslint rule caught this here —
// and the same trap cost two red gate runs earlier today.)
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: mockIncCounter,
  setGauge: mockSetGauge,
  observe: mockObserve,
}));

const { maxBuildsPerReplica, withReplicaBuildSlot, buildGateState, _resetBuildGate } =
  await import('../src/queue/build-gate.js');

afterEach(() => { delete process.env.PLUGIN_MAX_BUILDS_PER_REPLICA; });

describe('BUILD_LADDER_CONCURRENCY_SUM', () => {
  it('is the sum of every tier row, because each tier gets its own Worker', () => {
    const expected = BUILD_TIER_LADDER.reduce((n, t) => n + BUILD_TIER_CONCURRENCY[t], 0);
    expect(BUILD_LADDER_CONCURRENCY_SUM).toBe(expected);
    // Pinned so the fleet ceiling cannot move unnoticed: this times the plugin
    // deployment's KEDA maxReplicaCount (8) is how many builds the fleet can run.
    expect(BUILD_LADDER_CONCURRENCY_SUM).toBe(13);
  });
});

describe('maxBuildsPerReplica', () => {
  it('defaults to the shipped ladder sum, so it binds nothing today', () => {
    expect(maxBuildsPerReplica()).toBe(BUILD_LADDER_CONCURRENCY_SUM);
  });

  it('is overridable, which is the lever when the sidecar memory is the constraint', () => {
    process.env.PLUGIN_MAX_BUILDS_PER_REPLICA = '4';
    expect(maxBuildsPerReplica()).toBe(4);
  });

  it('refuses a zero or negative budget rather than wedging every build', () => {
    // `min: 1` — a 0 here would queue every build forever, which is a far worse
    // failure than running one at a time.
    process.env.PLUGIN_MAX_BUILDS_PER_REPLICA = '0';
    expect(maxBuildsPerReplica()).toBe(1);
    process.env.PLUGIN_MAX_BUILDS_PER_REPLICA = '-5';
    expect(maxBuildsPerReplica()).toBe(1);
  });

  it('ignores garbage and keeps the declared default', () => {
    process.env.PLUGIN_MAX_BUILDS_PER_REPLICA = 'lots';
    expect(maxBuildsPerReplica()).toBe(BUILD_LADDER_CONCURRENCY_SUM);
  });
});

describe('the replica gate wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetBuildGate();
    delete process.env.PLUGIN_MAX_BUILDS_PER_REPLICA;
  });

  it('publishes occupancy, which is the number to compare with the sidecar memory', async () => {
    // One replica's builds all drive ONE buildkitd with one memory limit, so this
    // gauge and BUILDKIT_MEMORY_LIMIT are the pair an operator reasons with. The
    // PluginReplicaBuildBudgetSaturated alert reads exactly this series.
    await withReplicaBuildSlot('enterprise', () => Promise.resolve('built'));
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_build_replica_inflight', {}, expect.any(Number));
  });

  it('counts a build that had to QUEUE for the replica budget', async () => {
    process.env.PLUGIN_MAX_BUILDS_PER_REPLICA = '1';
    let release: () => void = () => undefined;
    const first = withReplicaBuildSlot('pro', () => new Promise<void>((r) => { release = r; }));
    const second = withReplicaBuildSlot('pro', () => Promise.resolve());
    await Promise.resolve();

    // Over the budget the caller waits — it is never refused, because refusing
    // would turn a capacity limit into a failed build.
    expect(buildGateState()).toEqual({ inFlight: 1, waiting: 1 });
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_build_replica_queued_total', {});

    release();
    await Promise.all([first, second]);
    expect(buildGateState()).toEqual({ inFlight: 0, waiting: 0 });
  });

  it('records the wait per TIER, so a starved tier is identifiable', async () => {
    await withReplicaBuildSlot('developer', () => Promise.resolve());
    expect(mockObserve).toHaveBeenCalledWith('plugin_build_replica_wait_seconds', { tier: 'developer' }, expect.any(Number));
  });

  it('releases the slot when the build THROWS', async () => {
    // A failed build that kept its slot would shrink the replica's capacity
    // permanently and silently — the gate would close one notch per failure.
    await expect(withReplicaBuildSlot('team', () => Promise.reject(new Error('buildctl exit 1'))))
      .rejects.toThrow('buildctl exit 1');
    expect(buildGateState()).toEqual({ inFlight: 0, waiting: 0 });
  });
});
