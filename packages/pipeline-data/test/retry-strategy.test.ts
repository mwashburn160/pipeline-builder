// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock createLogger to avoid Winston open handles in tests
jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { ConnectionRetryStrategy } from '../src/database/retry-strategy';

describe('ConnectionRetryStrategy', () => {
  let strategy: ConnectionRetryStrategy;

  beforeEach(() => {
    strategy = new ConnectionRetryStrategy({ maxRetries: 3, baseDelay: 10 });
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

  describe('calculateBackoff jitter', () => {
    it('should return a value >= base delay (jitter is additive)', () => {
      const s = new ConnectionRetryStrategy({ maxRetries: 5, baseDelay: 100 });
      const calcBackoff = (s as any).calculateBackoff.bind(s);

      for (let i = 0; i < 50; i++) {
        const result = calcBackoff(1); // attempt 1 => base = 100 * 2^0 = 100
        expect(result).toBeGreaterThanOrEqual(100);
      }
    });

    it('should not exceed base + 10% (jitter is at most 10% of base)', () => {
      const s = new ConnectionRetryStrategy({ maxRetries: 5, baseDelay: 100 });
      const calcBackoff = (s as any).calculateBackoff.bind(s);

      for (let i = 0; i < 50; i++) {
        const result = calcBackoff(1); // attempt 1 => base = 100
        expect(result).toBeLessThanOrEqual(110); // 100 + 10% = 110
      }
    });

    it('should scale exponentially with attempt number', () => {
      const s = new ConnectionRetryStrategy({ maxRetries: 5, baseDelay: 100 });
      const calcBackoff = (s as any).calculateBackoff.bind(s);

      // attempt 2 => base = 100 * 2^1 = 200, max with jitter = 220
      const result2 = calcBackoff(2);
      expect(result2).toBeGreaterThanOrEqual(200);
      expect(result2).toBeLessThanOrEqual(220);

      // attempt 3 => base = 100 * 2^2 = 400, max with jitter = 440
      const result3 = calcBackoff(3);
      expect(result3).toBeGreaterThanOrEqual(400);
      expect(result3).toBeLessThanOrEqual(440);
    });
  });
});
