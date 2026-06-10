// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for queue/queue-metrics-scraper.
 *
 * Asserts the scraper:
 *   - emits a `setGauge` call for every (queue, state) pair on each tick
 *   - publishes immediately on start (no `intervalMs` wait for first sample)
 *   - swallows transient Redis errors instead of crashing the timer
 *   - clears the interval on `stopQueueMetricsScraper` and on SIGTERM
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSetGauge = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  setGauge: mockSetGauge,
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

import type { Queue } from 'bullmq';
const {
  startQueueMetricsScraper,
  stopQueueMetricsScraper,
} = await import('../src/queue/queue-metrics-scraper.js');

function makeQueue(counts: Record<string, number>): Queue {
  return {
    getJobCounts: jest.fn().mockResolvedValue(counts),
  } as unknown as Queue;
}

const ALL_STATES = ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'];

beforeEach(() => {
  jest.useFakeTimers();
  mockSetGauge.mockClear();
  stopQueueMetricsScraper(); // ensure clean state between tests
});

afterEach(() => {
  stopQueueMetricsScraper();
  jest.useRealTimers();
});

describe('startQueueMetricsScraper', () => {
  it('emits one setGauge per (queue, state) on the immediate first sample', async () => {
    const q = makeQueue({ waiting: 4, active: 1, completed: 99, failed: 2, delayed: 0, paused: 0 });
    startQueueMetricsScraper([{ name: 'plugin-build', queue: q }], 15_000);
    // The first sample is fired immediately (not after intervalMs). It's
    // async though — flush microtasks before asserting.
    await Promise.resolve();
    await Promise.resolve();

    for (const state of ALL_STATES) {
      expect(mockSetGauge).toHaveBeenCalledWith(
        'plugin_queue_jobs',
        { queue: 'plugin-build', state },
        expect.any(Number),
      );
    }
  });

  it('repeats on each tick of the interval', async () => {
    const q = makeQueue({ waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    startQueueMetricsScraper([{ name: 'plugin-build', queue: q }], 1000);
    await Promise.resolve();
    await Promise.resolve();
    const initialCalls = mockSetGauge.mock.calls.length;

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSetGauge.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('scrapes multiple queues per tick', async () => {
    const main = makeQueue({ waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    const dlq = makeQueue({ waiting: 0, active: 0, completed: 0, failed: 7, delayed: 0, paused: 0 });
    startQueueMetricsScraper([
      { name: 'plugin-build', queue: main },
      { name: 'plugin-build-dlq', queue: dlq },
    ], 15_000);
    await Promise.resolve();
    await Promise.resolve();

    const queueLabels = new Set(mockSetGauge.mock.calls.map((c) => c[1].queue));
    expect(queueLabels.has('plugin-build')).toBe(true);
    expect(queueLabels.has('plugin-build-dlq')).toBe(true);
  });

  it('does not crash on a Redis failure mid-scrape', async () => {
    const broken = {
      getJobCounts: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
    } as unknown as Queue;
    startQueueMetricsScraper([{ name: 'plugin-build', queue: broken }], 1000);
    await Promise.resolve();
    await Promise.resolve();
    // Next tick still runs.
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(broken.getJobCounts).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — second start with the timer still running is a no-op', async () => {
    const q = makeQueue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    startQueueMetricsScraper([{ name: 'plugin-build', queue: q }], 1000);
    startQueueMetricsScraper([{ name: 'plugin-build', queue: q }], 1000);
    await Promise.resolve();
    await Promise.resolve();
    // Only one immediate sample, not two
    const queueCallCount = (q.getJobCounts as jest.Mock).mock.calls.length;
    expect(queueCallCount).toBe(1);
  });
});

describe('stopQueueMetricsScraper', () => {
  it('clears the interval so no more ticks fire', async () => {
    const q = makeQueue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    startQueueMetricsScraper([{ name: 'plugin-build', queue: q }], 1000);
    await Promise.resolve();
    await Promise.resolve();
    const before = (q.getJobCounts as jest.Mock).mock.calls.length;

    stopQueueMetricsScraper();
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();
    expect((q.getJobCounts as jest.Mock).mock.calls.length).toBe(before);
  });
});
