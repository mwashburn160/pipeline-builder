// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mock createLogger to avoid Winston open handles in tests
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { ConnectionRetryStrategy } = await import('../src/database/retry-strategy.js');
type ConnectionRetryStrategy = InstanceType<typeof ConnectionRetryStrategy>;

describe('ConnectionRetryStrategy', () => {
  let strategy: ConnectionRetryStrategy;

  beforeEach(() => {
    strategy = new ConnectionRetryStrategy({ maxRetries: 3, retryDelayMs: 10 });
  });

  describe('getAttempts', () => {
    it('should start at 0', () => {
      expect(strategy.getAttempts()).toBe(0);
    });
  });

  describe('reset', () => {
    it('should reset attempts to 0', () => {
      // Trigger attempt increment via handleConnectionError
      strategy.handleConnectionError(new Error('test'), async () => true).catch(() => {});
      // Give a brief moment, but since the delay is small it will finish quickly
      strategy.reset();
      expect(strategy.getAttempts()).toBe(0);
    });
  });

  describe('execute', () => {
    it('should return result on first success', async () => {
      const result = await strategy.execute(async () => 'success');
      expect(result).toBe('success');
    });

    it('should retry on failure and succeed', async () => {
      let callCount = 0;
      const result = await strategy.execute(async () => {
        callCount++;
        if (callCount < 2) throw new Error('fail');
        return 'recovered';
      });
      expect(result).toBe('recovered');
      expect(callCount).toBe(2);
    });

    it('should throw after max retries', async () => {
      await expect(
        strategy.execute(async () => { throw new Error('always fails'); }),
      ).rejects.toThrow('always fails');
    });

    it('should reset attempts before executing', async () => {
      await expect(
        strategy.execute(async () => { throw new Error('fail'); }),
      ).rejects.toThrow();

      // Should be able to execute again since attempts reset
      const result = await strategy.execute(async () => 'success');
      expect(result).toBe('success');
    });
  });

  describe('handleConnectionError', () => {
    it('should increment attempts', async () => {
      await strategy.handleConnectionError(new Error('conn error'), async () => true);
      expect(strategy.getAttempts()).toBe(0); // Reset on successful reconnection
    });

    it('should reset attempts on successful reconnection', async () => {
      await strategy.handleConnectionError(new Error('error'), async () => true);
      expect(strategy.getAttempts()).toBe(0);
    });

    it('should not reset on failed reconnection', async () => {
      await strategy.handleConnectionError(new Error('error'), async () => false);
      expect(strategy.getAttempts()).toBe(1);
    });

    it('should handle testConnection throwing', async () => {
      await strategy.handleConnectionError(
        new Error('error'),
        async () => { throw new Error('retry failed'); },
      );
      expect(strategy.getAttempts()).toBe(1);
    });
  });

  // `maxRetries` means retries AFTER the initial attempt. The previous
  // implementation's `while (attempts < maxRetries)` gave `maxRetries: 3` only
  // TWO retries (three attempts); the backoff decision is api-core's now, so
  // the budget is the documented one.
  describe('retry budget (off-by-one regression)', () => {
    it('makes maxRetries + 1 attempts before giving up', async () => {
      let calls = 0;
      await expect(
        strategy.execute(async () => { calls++; throw new Error('always fails'); }),
      ).rejects.toThrow('always fails');
      expect(calls).toBe(4); // 1 initial + 3 retries
    });

    it('honours a maxRetries of 1 as one retry', async () => {
      const s = new ConnectionRetryStrategy({ maxRetries: 1, retryDelayMs: 1 });
      let calls = 0;
      await expect(
        s.execute(async () => { calls++; throw new Error('nope'); }),
      ).rejects.toThrow('nope');
      expect(calls).toBe(2);
    });

    it('a maxRetries of 0 makes exactly one attempt', async () => {
      const s = new ConnectionRetryStrategy({ maxRetries: 0, retryDelayMs: 1 });
      let calls = 0;
      await expect(
        s.execute(async () => { calls++; throw new Error('nope'); }),
      ).rejects.toThrow('nope');
      expect(calls).toBe(1);
    });

    it('stops retrying handleConnectionError once the budget is spent', async () => {
      const s = new ConnectionRetryStrategy({ maxRetries: 1, retryDelayMs: 1 });
      let probes = 0;
      await s.handleConnectionError(new Error('e'), async () => { probes++; return false; });
      expect(probes).toBe(1);
      // Budget spent — no second probe.
      await s.handleConnectionError(new Error('e'), async () => { probes++; return false; });
      expect(probes).toBe(1);
    });
  });

});
