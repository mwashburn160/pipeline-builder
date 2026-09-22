// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the S2S circuit breaker: open after threshold, fast-fail while
 * open, half-open probe on cooldown, and close on a successful probe.
 */

import type { AnyFn } from '../src/testing/any-fn.js';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: jest.fn<AnyFn>(), warn: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), debug: jest.fn<AnyFn>() }),
}));

const { CircuitBreaker } = await import('../src/services/circuit-breaker.js');

describe('CircuitBreaker', () => {
  const cfg = { failureThreshold: 3, cooldownMs: 1000, enabled: true };

  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('stays closed and allows requests below the failure threshold', () => {
    const b = new CircuitBreaker('svc:1', cfg);
    b.recordFailure();
    b.recordFailure();
    expect(b.getState()).toBe('closed');
    expect(b.allowRequest()).toBe(true);
  });

  it('opens after threshold consecutive failures and fast-fails', () => {
    const b = new CircuitBreaker('svc:1', cfg);
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    expect(b.getState()).toBe('open');
    expect(b.allowRequest()).toBe(false);
  });

  it('a success resets the consecutive-failure count (no premature open)', () => {
    const b = new CircuitBreaker('svc:1', cfg);
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    expect(b.getState()).toBe('closed');
  });

  it('half-opens after cooldown, allowing a single probe', () => {
    const b = new CircuitBreaker('svc:1', cfg);
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    expect(b.allowRequest()).toBe(false); // still open, before cooldown
    jest.advanceTimersByTime(1000);
    expect(b.allowRequest()).toBe(true); // transitions to half-open, one probe
    expect(b.getState()).toBe('half-open');
    expect(b.allowRequest()).toBe(false); // second concurrent probe blocked
  });

  it('expires a half-open probe that never reported back, admitting a new one', () => {
    const b = new CircuitBreaker('svc:1', cfg);
    b.recordFailure(); b.recordFailure(); b.recordFailure();
    jest.advanceTimersByTime(1000);
    expect(b.allowRequest()).toBe(true); // probe admitted…
    // …and lost (hung socket / swallowed promise): no recordSuccess/Failure.
    jest.advanceTimersByTime(999);
    expect(b.allowRequest()).toBe(false); // still within the probe's window
    jest.advanceTimersByTime(1);
    expect(b.allowRequest()).toBe(true); // stale probe expired — gate re-opens
    expect(b.allowRequest()).toBe(false); // but still one probe at a time
    b.recordSuccess();
    expect(b.getState()).toBe('closed');
  });

  it('closes when the half-open probe succeeds', () => {
    const b = new CircuitBreaker('svc:1', cfg);
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    jest.advanceTimersByTime(1000);
    b.allowRequest(); // half-open probe
    b.recordSuccess();
    expect(b.getState()).toBe('closed');
    expect(b.allowRequest()).toBe(true);
  });

  it('re-opens when the half-open probe fails', () => {
    const b = new CircuitBreaker('svc:1', cfg);
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    jest.advanceTimersByTime(1000);
    b.allowRequest(); // half-open probe
    b.recordFailure();
    expect(b.getState()).toBe('open');
    expect(b.allowRequest()).toBe(false);
  });

  it('is a no-op when disabled (always allows, never changes state)', () => {
    const b = new CircuitBreaker('svc:1', { ...cfg, enabled: false });
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    expect(b.getState()).toBe('closed');
    expect(b.allowRequest()).toBe(true);
  });
});
