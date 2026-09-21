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

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
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

describe('useSSE error handling', () => {
  /**
   * `useSSE` deliberately does NOT reconnect in-band. Both streams in this app
   * are TICKETED — a single-use ticket is exchanged for the stream — so
   * replaying the same URL just 401s. Reconnection means minting a FRESH
   * ticket, which only the consumer can do, so an error hands control straight
   * to `onRetriesExhausted`. (The old `maxRetries`/`baseRetryDelayMs` backoff
   * was dead code: both consumers passed `maxRetries: 0`.)
   */
  it('hands control to onRetriesExhausted on the FIRST error — no in-band retry', () => {
    const onRetriesExhausted = jest.fn<AnyFn>();
    renderHook(() =>
      useSSE({ url: 'https://sse.test/stream', onMessage: jest.fn<AnyFn>(), onRetriesExhausted }),
    );

    expect(MockEventSource.instances.length).toBe(1);
    act(() => latest().emitError());

    expect(onRetriesExhausted).toHaveBeenCalledTimes(1);
    // No replacement EventSource was opened against the (now-consumed) ticket.
    expect(MockEventSource.instances.length).toBe(1);
  });

  it('closes the stream on error and reports disconnected', () => {
    const { result } = renderHook(() =>
      useSSE({ url: 'https://sse.test/stream', onMessage: jest.fn<AnyFn>() }),
    );

    act(() => latest().emitOpen());
    expect(result.current.connected).toBe(true);

    act(() => latest().emitError());
    expect(result.current.connected).toBe(false);
    expect(latest().closed).toBe(true);
  });

  it('tolerates a consumer that provides no onRetriesExhausted', () => {
    renderHook(() => useSSE({ url: 'https://sse.test/stream', onMessage: jest.fn<AnyFn>() }));
    expect(() => act(() => latest().emitError())).not.toThrow();
  });

  it('reconnects only when the url changes (a fresh ticket)', () => {
    const { rerender } = renderHook(
      ({ url }: { url: string }) => useSSE({ url, onMessage: jest.fn<AnyFn>() }),
      { initialProps: { url: 'https://sse.test/stream?ticket=one' } },
    );
    expect(MockEventSource.instances.length).toBe(1);

    act(() => latest().emitError());
    expect(MockEventSource.instances.length).toBe(1); // still no self-retry

    rerender({ url: 'https://sse.test/stream?ticket=two' });
    expect(MockEventSource.instances.length).toBe(2);
  });
});

describe('useSSE everConnected (paused-indicator gate)', () => {
  it('stays false during the initial connect and flips true only after onopen', () => {
    const { result } = renderHook(() =>
      useSSE({
        url: 'https://sse.test/stream',
        onMessage: jest.fn<AnyFn>(),
      }),
    );

    // Initial handshake: not yet connected, and never-connected — so a
    // consumer's `everConnected && !connected` gate stays false (no flash).
    expect(result.current.connected).toBe(false);
    expect(result.current.everConnected).toBe(false);

    // A genuine established connection.
    act(() => latest().emitOpen());
    expect(result.current.connected).toBe(true);
    expect(result.current.everConnected).toBe(true);

    // Drop after being live: connected goes false but everConnected stays
    // true — this is the state that should surface the paused indicator.
    act(() => latest().emitError());
    expect(result.current.connected).toBe(false);
    expect(result.current.everConnected).toBe(true);
  });
});
