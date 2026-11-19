// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The run-request pollers share ONE AbortSignal across every sleep of a
 * follow that can last 15 minutes (queued) plus an hour (execution). Each
 * sleep must take its abort listener back off the signal when the timer wins,
 * or the signal collects one closure per poll for the life of the page.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';

jest.mock('../src/lib/api', () => ({ __esModule: true, default: {}, api: {} }));

import { pollRunRequest, pollExecutionStatus } from '../src/hooks/useRunRequestTracker';

/** A signal whose live 'abort' listener count is observable. */
function countingSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  let live = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions | boolean) => {
    if (type === 'abort') live += 1;
    add(type, fn, opts);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: EventListenerOptions | boolean) => {
    if (type === 'abort') live -= 1;
    remove(type, fn, opts);
  }) as typeof signal.removeEventListener;
  return { signal, live: () => live };
}

const request = (status: string, extra: Record<string, unknown> = {}) => ({
  success: true,
  data: { status, runnerLabel: 'r', executionId: 'e1', expiresAt: new Date(Date.now() + 600_000).toISOString(), ...extra },
});

afterEach(() => { jest.useRealTimers(); });

describe('run-request polling', () => {
  it('leaves no abort listeners behind on the shared signal (queued phase)', async () => {
    jest.useFakeTimers();
    const { signal, live } = countingSignal();
    const read = jest.fn<AnyFn>()
      .mockResolvedValueOnce(request('pending'))
      .mockResolvedValueOnce(request('pending'))
      .mockResolvedValueOnce(request('pending'))
      .mockResolvedValueOnce(request('started', { executionStatus: 'InProgress' }));

    const run = pollRunRequest(read as never, { signal });
    await jest.advanceTimersByTimeAsync(60_000);
    const result = await run;

    expect(result).toMatchObject({ status: 'started' });
    expect(read).toHaveBeenCalledTimes(4);
    expect(live()).toBe(0);
  });

  it('leaves no abort listeners behind on the shared signal (execution phase)', async () => {
    jest.useFakeTimers();
    const { signal, live } = countingSignal();
    const read = jest.fn<AnyFn>()
      .mockResolvedValueOnce(request('started', { executionStatus: 'InProgress' }))
      .mockResolvedValueOnce(request('started', { executionStatus: 'InProgress' }))
      .mockResolvedValueOnce(request('started', { executionStatus: 'Succeeded' }));

    const run = pollExecutionStatus(read as never, { signal });
    await jest.advanceTimersByTimeAsync(60_000);

    expect(await run).toBe('Succeeded');
    expect(live()).toBe(0);
  });
});
