// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * useTicketedSSE owns the ticket exchange + fresh-ticket reconnect for every
 * ticketed stream; useBuildStatus is a bounded consumer of it.
 *
 *   - Defaults keep the long-lived streams alive forever (no give-up).
 *   - `maxRetries` + `onGiveUp` bound a stream; the budget covers failed ticket
 *     mints as well as stream errors, and resets for a new subscription.
 *   - Returning `true` from `onMessage` closes the stream for good.
 *   - A build whose ticket mint blips once still streams (it used to be marked
 *     failed on the first mint error); a build that can't reconnect fails.
 */

import { act, renderHook } from '@testing-library/react';
import { useTicketedSSE, type TicketedSSEOptions } from '../src/hooks/useTicketedSSE';
import { useBuildStatus } from '../src/hooks/useBuildStatus';
import { BUILD_SSE_MAX_RETRIES } from '../src/lib/constants';

const getBuildLogTicket = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    isAuthenticated: () => true,
    getBuildLogTicket: (...a: unknown[]) => getBuildLogTicket(...a),
  },
}));
const clearPluginCache = jest.fn();
jest.mock('@/hooks/usePlugins', () => ({ __esModule: true, clearPluginCache: () => clearPluginCache() }));

class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) { MockEventSource.instances.push(this); }
  close() { this.closed = true; }
}
const latest = () => MockEventSource.instances[MockEventSource.instances.length - 1];
const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;

/** Settle pending promise callbacks (ticket mints) inside act. */
async function flush() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}
/** Run every pending backoff timer, then settle the mint it triggers. */
async function runBackoff() {
  await act(async () => { jest.advanceTimersByTime(60_000); });
  await flush();
}

/** Tickets are single-use, so each mint returns a distinct one. */
let minted = 0;

beforeEach(() => {
  minted = 0;
  MockEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
});

function renderTicketed(overrides: Partial<TicketedSSEOptions> = {}) {
  const opts: TicketedSSEOptions = {
    subscriptionKey: 'k1',
    getTicket: jest.fn().mockImplementation(async () => `t${++minted}`),
    buildUrl: (ticket, key) => `/stream/${key}?ticket=${ticket}`,
    onMessage: jest.fn(),
    ...overrides,
  };
  const hook = renderHook((p: TicketedSSEOptions) => useTicketedSSE(p), { initialProps: opts });
  return { ...hook, opts };
}

describe('useTicketedSSE', () => {
  it('passes the subscription key to getTicket/buildUrl', async () => {
    const { opts } = renderTicketed();
    await flush();
    expect(opts.getTicket).toHaveBeenCalledWith('k1');
    expect(latest().url).toBe('/stream/k1?ticket=t1');
  });

  it('by default never gives up on failed ticket mints', async () => {
    const getTicket = jest.fn().mockRejectedValue(new Error('503'));
    const onGiveUp = jest.fn();
    renderTicketed({ getTicket, onGiveUp });
    await flush();
    for (let i = 0; i < 8; i++) await runBackoff();
    expect(getTicket).toHaveBeenCalledTimes(9);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('gives up after maxRetries failed mints and calls onGiveUp once', async () => {
    const getTicket = jest.fn().mockRejectedValue(new Error('503'));
    const onGiveUp = jest.fn();
    renderTicketed({ getTicket, onGiveUp, maxRetries: 2 });
    await flush();
    for (let i = 0; i < 5; i++) await runBackoff();
    expect(getTicket).toHaveBeenCalledTimes(3); // first try + 2 retries
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it('counts stream errors against maxRetries too', async () => {
    const onGiveUp = jest.fn();
    renderTicketed({ onGiveUp, maxRetries: 1 });
    await flush();
    act(() => latest().onerror?.({}));
    await runBackoff();
    expect(MockEventSource.instances).toHaveLength(2);
    act(() => latest().onerror?.({}));
    await runBackoff();
    expect(MockEventSource.instances).toHaveLength(2);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it('a new subscription key restarts a stream that gave up', async () => {
    const getTicket = jest.fn().mockRejectedValue(new Error('503'));
    const onGiveUp = jest.fn();
    const { rerender, opts } = renderTicketed({ getTicket, onGiveUp, maxRetries: 0 });
    await flush();
    expect(onGiveUp).toHaveBeenCalledTimes(1);

    getTicket.mockResolvedValue('t2');
    rerender({ ...opts, subscriptionKey: 'k2' });
    await flush();
    expect(latest().url).toBe('/stream/k2?ticket=t2');
  });

  it('closes the stream for good when onMessage returns true', async () => {
    const getTicket = jest.fn().mockResolvedValue('t');
    renderTicketed({ getTicket, onMessage: (d) => (d as { done?: boolean }).done === true });
    await flush();
    const es = latest();
    act(() => es.onopen?.({}));

    act(() => es.onmessage?.({ data: JSON.stringify({ done: false }) }));
    expect(es.closed).toBe(false);
    act(() => es.onmessage?.({ data: JSON.stringify({ done: true }) }));
    expect(es.closed).toBe(true);

    await runBackoff();
    expect(getTicket).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances).toHaveLength(1);
  });
});

describe('useBuildStatus', () => {
  it('retries a failed ticket mint instead of failing the build', async () => {
    getBuildLogTicket.mockRejectedValueOnce(new Error('503')).mockResolvedValue('tk');
    const { result } = renderHook(() => useBuildStatus('req-1'));
    await flush();
    expect(result.current.status).toBe('building');

    await runBackoff();
    expect(result.current.status).toBe('building');
    expect(latest().url).toBe('/api/plugins/logs/req-1?ticket=tk');
  });

  it('marks the build failed once reconnects are exhausted', async () => {
    getBuildLogTicket.mockRejectedValue(new Error('503'));
    const { result } = renderHook(() => useBuildStatus('req-1'));
    await flush();
    for (let i = 1; i < BUILD_SSE_MAX_RETRIES; i++) {
      await runBackoff();
      expect(result.current.status).toBe('building');
    }
    await runBackoff();
    expect(getBuildLogTicket).toHaveBeenCalledTimes(BUILD_SSE_MAX_RETRIES + 1);
    expect(result.current.status).toBe('failed');
  });

  it('records events, completes, and closes the stream on COMPLETED', async () => {
    getBuildLogTicket.mockResolvedValue('tk');
    const { result } = renderHook(() => useBuildStatus('req-1'));
    await flush();
    const es = latest();
    act(() => es.onmessage?.({ data: JSON.stringify({ ts: '1', type: 'INFO', message: 'step' }) }));
    expect(es.closed).toBe(false);
    act(() => es.onmessage?.({ data: JSON.stringify({ ts: '2', type: 'COMPLETED', message: 'done' }) }));

    expect(result.current.status).toBe('completed');
    expect(result.current.events).toHaveLength(2);
    expect(result.current.lastEvent?.message).toBe('done');
    expect(clearPluginCache).toHaveBeenCalled();
    expect(es.closed).toBe(true);
    await runBackoff();
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('fails and closes the stream on ERROR', async () => {
    getBuildLogTicket.mockResolvedValue('tk');
    const { result } = renderHook(() => useBuildStatus('req-1'));
    await flush();
    act(() => latest().onmessage?.({ data: JSON.stringify({ ts: '1', type: 'ERROR', message: 'boom' }) }));
    expect(result.current.status).toBe('failed');
    expect(latest().closed).toBe(true);
  });

  it('stays idle without a request id', async () => {
    const { result } = renderHook(() => useBuildStatus(null));
    await flush();
    expect(result.current.status).toBe('idle');
    expect(getBuildLogTicket).not.toHaveBeenCalled();
  });
});
