// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for useSSE — the generic EventSource hook with exponential-backoff
 * reconnect used by useBuildStatus and useMessageNotifications.
 *
 * Regression guard: a received SSE *message* must NOT reset the retry counter.
 * Only a genuinely established connection (EventSource `onopen`) is the signal
 * that the connection is healthy and the counter may reset. If a message reset
 * the counter, a flapping connection (open → 1 message → drop, repeat) would
 * never approach `maxRetries`, backoff would stay pinned at the base delay, and
 * the hook would reconnect forever — a reconnect storm. These tests assert that
 * (1) message→drop cycles WITHOUT an onopen keep incrementing the counter (so
 * `onRetriesExhausted` is reachable and the backoff delay grows), and (2) an
 * onopen resets the counter (backoff returns to the base delay).
 */

import { act, renderHook } from '@testing-library/react';
import { useSSE } from '../src/hooks/useSSE';

// ---------------------------------------------------------------------------
// Mock EventSource
// ---------------------------------------------------------------------------
class MockEventSource {
  static instances: MockEventSource[] = [];

  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  // --- test drivers ---
  emitOpen() {
    this.onopen?.({});
  }
  emitMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  emitError() {
    this.onerror?.({});
  }
}

/** The most recently constructed EventSource (the currently-live connection). */
function latest(): MockEventSource {
  return MockEventSource.instances[MockEventSource.instances.length - 1];
}

const originalEventSource = (globalThis as any).EventSource;

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as any).EventSource = MockEventSource;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  (globalThis as any).EventSource = originalEventSource;
});

describe('useSSE reconnect/backoff', () => {
  it('does NOT reset the retry counter on received messages (exhaustion stays reachable, backoff grows)', () => {
    const onMessage = jest.fn();
    const onRetriesExhausted = jest.fn();

    renderHook(() =>
      useSSE({
        url: 'https://sse.test/stream',
        maxRetries: 3,
        baseRetryDelayMs: 1000,
        onMessage,
        onRetriesExhausted,
      }),
    );

    // Initial connection.
    expect(MockEventSource.instances.length).toBe(1);

    // Cycle 1: deliver a message, then drop — no onopen. Reconnect at base delay (1000ms).
    act(() => {
      latest().emitMessage({ n: 1 });
      latest().emitError();
    });
    act(() => jest.advanceTimersByTime(999));
    expect(MockEventSource.instances.length).toBe(1); // backoff not elapsed yet
    act(() => jest.advanceTimersByTime(1));
    expect(MockEventSource.instances.length).toBe(2); // reconnected

    // Cycle 2: message + drop. If the message had reset the counter, this would
    // reconnect at 1000ms again. It must take 2000ms (2^1) — proving the counter climbed.
    act(() => {
      latest().emitMessage({ n: 2 });
      latest().emitError();
    });
    act(() => jest.advanceTimersByTime(1999));
    expect(MockEventSource.instances.length).toBe(2);
    act(() => jest.advanceTimersByTime(1));
    expect(MockEventSource.instances.length).toBe(3);

    // Cycle 3: message + drop. Delay must be 4000ms (2^2) — counter still climbing.
    act(() => {
      latest().emitMessage({ n: 3 });
      latest().emitError();
    });
    act(() => jest.advanceTimersByTime(3999));
    expect(MockEventSource.instances.length).toBe(3);
    act(() => jest.advanceTimersByTime(1));
    expect(MockEventSource.instances.length).toBe(4);

    // Cycle 4: counter is now at maxRetries (3). One more drop exhausts retries —
    // reachable only because messages never reset the counter.
    expect(onRetriesExhausted).not.toHaveBeenCalled();
    act(() => {
      latest().emitMessage({ n: 4 });
      latest().emitError();
    });
    expect(onRetriesExhausted).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(4);
    // No further reconnect after exhaustion.
    expect(MockEventSource.instances.length).toBe(4);
  });

  it('resets the retry counter on onopen (a healthy established connection)', () => {
    const onRetriesExhausted = jest.fn();

    renderHook(() =>
      useSSE({
        url: 'https://sse.test/stream',
        maxRetries: 3,
        baseRetryDelayMs: 1000,
        onMessage: jest.fn(),
        onRetriesExhausted,
      }),
    );

    // Two drops without onopen push the counter to 2.
    act(() => latest().emitError()); // counter -> 1, delay 1000
    act(() => jest.advanceTimersByTime(1000));
    expect(MockEventSource.instances.length).toBe(2);

    act(() => latest().emitError()); // counter -> 2, delay 2000
    act(() => jest.advanceTimersByTime(2000));
    expect(MockEventSource.instances.length).toBe(3);

    // A genuinely established connection fires onopen — this resets the counter.
    act(() => latest().emitOpen());

    // Next drop: if the counter were still 2, backoff would be 4000ms. Because
    // onopen reset it to 0, the drop makes it 1 and reconnect happens at the
    // BASE delay (1000ms). Advancing 999ms must not reconnect; 1000ms must.
    act(() => latest().emitError());
    act(() => jest.advanceTimersByTime(999));
    expect(MockEventSource.instances.length).toBe(3); // still base-delay window
    act(() => jest.advanceTimersByTime(1));
    expect(MockEventSource.instances.length).toBe(4); // reconnected at base delay => reset confirmed

    // And exhaustion now takes a fresh full run of maxRetries (delays 2000, 4000).
    act(() => latest().emitError()); // counter -> 2
    act(() => jest.advanceTimersByTime(2000));
    expect(MockEventSource.instances.length).toBe(5);

    act(() => latest().emitError()); // counter -> 3
    act(() => jest.advanceTimersByTime(4000));
    expect(MockEventSource.instances.length).toBe(6);

    expect(onRetriesExhausted).not.toHaveBeenCalled();
    act(() => latest().emitError()); // counter already at max => exhausted
    expect(onRetriesExhausted).toHaveBeenCalledTimes(1);
  });
});
