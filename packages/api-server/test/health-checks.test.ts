// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

const mockTestConnection = jest.fn();

jest.mock('@pipeline-builder/pipeline-core', () => ({
  getConnection: () => ({ testConnection: mockTestConnection }),
}));

import { postgresHealthCheck, mongoHealthCheck } from '../src/api/health-checks';

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
