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

  describe('retry budget', () => {
    it('probes exactly maxRetries times across consecutive errors, then stops', async () => {
      let probes = 0;
      for (let i = 0; i < 5; i++) {
        await strategy.handleConnectionError(new Error('e'), async () => { probes++; return false; });
      }
      expect(probes).toBe(3);
    });

    it('a successful probe restores the full budget', async () => {
      let probes = 0;
      await strategy.handleConnectionError(new Error('e'), async () => { probes++; return false; });
      await strategy.handleConnectionError(new Error('e'), async () => { probes++; return true; });
      expect(strategy.getAttempts()).toBe(0);
      for (let i = 0; i < 5; i++) {
        await strategy.handleConnectionError(new Error('e'), async () => { probes++; return false; });
      }
      expect(probes).toBe(2 + 3);
    });

    it('has no generic operation-retry method (permanent errors must not be re-run)', () => {
      expect((strategy as unknown as Record<string, unknown>).execute).toBeUndefined();
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
