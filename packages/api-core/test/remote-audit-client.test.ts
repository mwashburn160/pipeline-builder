// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the remote-audit client: verifies that best-effort emission is
 * retry-safe (carries an Idempotency-Key + a real retry budget) and stays
 * fire-and-forget (never throws to the caller).
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  getServiceAuthHeader: jest.fn(() => 'service-token-raw'),
}));

// Capture the post() calls made by the client under test.
const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../src/services/http-client.js', () => ({
  createSafeClient: () => ({ post: mockPost, get: jest.fn(), put: jest.fn(), delete: jest.fn() }),
}));

const { createRemoteAuditClient } = await import('../src/services/remote-audit-client.js');

const EVENT = {
  action: 'pipeline.create' as const,
  actorId: 'user-1',
  orgId: 'org-acme',
  targetType: 'pipeline',
  targetId: 'pl-123',
};

describe('createRemoteAuditClient.record', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({ statusCode: 200, body: {}, headers: {} });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('posts to /audit/events with a retry budget (transient failures are not single-shot)', async () => {
    const client = createRemoteAuditClient();
    client.record(EVENT, 'pipeline');
    // record() is fire-and-forget; let the microtask settle.
    await Promise.resolve();

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [path, body, options] = mockPost.mock.calls[0];
    expect(path).toBe('/audit/events');
    expect(body).toEqual(EVENT);
    // The whole point of the fix: this POST must be allowed to retry.
    expect(options.maxRetries).toBeGreaterThanOrEqual(2);
    expect(options.maxRateLimitRetries).toBeGreaterThanOrEqual(1);
  });

  it('carries an Idempotency-Key so the non-idempotent POST is retry-safe + dedup-able', async () => {
    const client = createRemoteAuditClient();
    client.record(EVENT, 'pipeline');
    await Promise.resolve();

    const options = mockPost.mock.calls[0][2];
    expect(options.headers.Authorization).toBe('service-token-raw');
    expect(typeof options.headers['Idempotency-Key']).toBe('string');
    expect(options.headers['Idempotency-Key'].length).toBeGreaterThan(0);
  });

  it('gives each emission a distinct Idempotency-Key', async () => {
    const client = createRemoteAuditClient();
    client.record(EVENT, 'pipeline');
    client.record(EVENT, 'pipeline');
    await Promise.resolve();

    const k1 = mockPost.mock.calls[0][2].headers['Idempotency-Key'];
    const k2 = mockPost.mock.calls[1][2].headers['Idempotency-Key'];
    expect(k1).not.toBe(k2);
  });

  it('never throws to the caller when the POST rejects (fire-and-forget)', async () => {
    mockPost.mockRejectedValue(new Error('platform down'));
    const client = createRemoteAuditClient();
    expect(() => client.record(EVENT, 'pipeline')).not.toThrow();
    // Let the rejected promise settle without an unhandled rejection.
    await Promise.resolve();
    await Promise.resolve();
  });
});
