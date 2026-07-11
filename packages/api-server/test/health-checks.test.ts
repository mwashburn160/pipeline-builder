// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';

const mockTestConnection = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  getConnection: () => ({ testConnection: mockTestConnection }),
}));

const { postgresHealthCheck, mongoHealthCheck, redisHealthCheck, combineHealthChecks } = await import('../src/api/health-checks.js');

describe('postgresHealthCheck', () => {
  beforeEach(() => {
    mockTestConnection.mockReset();
  });

  it('returns connected when testConnection succeeds', async () => {
    mockTestConnection.mockResolvedValue(true);
    const result = await postgresHealthCheck();
    expect(result).toEqual({ postgres: 'connected' });
  });

  it('returns disconnected when testConnection throws', async () => {
    // Probe failures are real failures — not "unknown". This change makes
    // /ready report 503 correctly when the DB is genuinely unreachable.
    mockTestConnection.mockRejectedValue(new Error('boom'));
    const result = await postgresHealthCheck();
    expect(result).toEqual({ postgres: 'disconnected' });
  });
});

describe('mongoHealthCheck', () => {
  it('returns connected when readyState is 1', async () => {
    const fn = mongoHealthCheck({ readyState: 1 });
    await expect(fn()).resolves.toEqual({ mongodb: 'connected' });
  });

  it('returns unknown when readyState is 2 (connecting)', async () => {
    // Only state 2 (actively connecting) is "unknown" — state 0
    // (disconnected) and 99 (uninitialized) report 'disconnected' so /ready
    // surfaces the failure.
    const fn = mongoHealthCheck({ readyState: 2 });
    await expect(fn()).resolves.toEqual({ mongodb: 'unknown' });
  });

  it('returns disconnected when readyState is 0 (disconnected)', async () => {
    const fn = mongoHealthCheck({ readyState: 0 });
    await expect(fn()).resolves.toEqual({ mongodb: 'disconnected' });
  });

  it('returns disconnected for any other readyState', async () => {
    const fn = mongoHealthCheck({ readyState: 3 });
    await expect(fn()).resolves.toEqual({ mongodb: 'disconnected' });
  });
});

describe('redisHealthCheck', () => {
  it('returns connected when PING resolves', async () => {
    const fn = redisHealthCheck({ ping: async () => 'PONG' });
    await expect(fn()).resolves.toEqual({ redis: 'connected' });
  });

  it('returns disconnected when PING rejects', async () => {
    const fn = redisHealthCheck({ ping: async () => { throw new Error('ECONNREFUSED'); } });
    await expect(fn()).resolves.toEqual({ redis: 'disconnected' });
  });

  it('returns disconnected (not hang) when PING never settles — timeout', async () => {
    // A BullMQ ioredis client with an offline queue can leave ping() pending
    // when redis is down; the probe must time-box it.
    const fn = redisHealthCheck({ ping: () => new Promise<string>(() => {}) }, 50);
    await expect(fn()).resolves.toEqual({ redis: 'disconnected' });
  });

  it('accepts an async client getter (e.g. BullMQ queue.client)', async () => {
    const fn = redisHealthCheck(async () => ({ ping: async () => 'PONG' }));
    await expect(fn()).resolves.toEqual({ redis: 'connected' });
  });

  it('returns disconnected when the client getter itself rejects', async () => {
    const fn = redisHealthCheck(async () => { throw new Error('no client'); });
    await expect(fn()).resolves.toEqual({ redis: 'disconnected' });
  });
});

describe('combineHealthChecks', () => {
  it('runs probes in parallel and merges their results', async () => {
    const fn = combineHealthChecks(
      async () => ({ postgres: 'connected' }),
      async () => ({ redis: 'connected' }),
    );
    await expect(fn()).resolves.toEqual({ postgres: 'connected', redis: 'connected' });
  });

  it('preserves a failing probe\'s status without dropping the others', async () => {
    const fn = combineHealthChecks(
      async () => ({ postgres: 'connected' }),
      async () => ({ redis: 'disconnected' }),
    );
    await expect(fn()).resolves.toEqual({ postgres: 'connected', redis: 'disconnected' });
  });

  it('does not let one probe throwing take down the merge', async () => {
    const fn = combineHealthChecks(
      async () => ({ postgres: 'connected' }),
      async () => { throw new Error('probe blew up'); },
    );
    await expect(fn()).resolves.toEqual({ postgres: 'connected' });
  });
});
