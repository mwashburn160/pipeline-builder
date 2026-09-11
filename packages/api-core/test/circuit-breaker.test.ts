// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the S2S circuit breaker: open after threshold, fast-fail while
 * open, half-open probe on cooldown, and close on a successful probe.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { CircuitBreaker } = await import('../src/services/circuit-breaker.js');

describe('CircuitBreaker', () => {
  const cfg = { failureThreshold: 3, cooldownMs: 1000, enabled: true };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

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
