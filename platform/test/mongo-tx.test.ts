// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for withMongoTransaction — the centralised wrapper that replaced
 * the 7-copy `startSession / withTransaction / endSession` boilerplate
 * across auth-service, organization-service, invitation-service, and
 * org-members-service.
 *
 * The Mongoose driver is fully mocked — we only validate the wrapper's
 * lifecycle contract (session handed to fn, ended on both success and
 * throw paths).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockEndSession = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
const mockWithTransaction = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockStartSession = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('mongoose', () => ({
  __esModule: true,
  default: {
    startSession: (...args: unknown[]) => mockStartSession(...args),
  },
  startSession: (...args: unknown[]) => mockStartSession(...args),
}));

const { withMongoTransaction } = await import('../src/utils/mongo-tx.js');

function makeSession() {
  return {
    withTransaction: mockWithTransaction,
    endSession: mockEndSession,
  };
}

describe('withMongoTransaction', () => {
  beforeEach(() => {
    mockStartSession.mockReset();
    mockWithTransaction.mockReset();
    mockEndSession.mockReset().mockResolvedValue(undefined);
  });

  it('passes a session to the body fn and returns its result', async () => {
    const session = makeSession();
    mockStartSession.mockResolvedValue(session);
    // Pass-through: run the body and let it set its `result` closure
    mockWithTransaction.mockImplementation(async (fn: () => Promise<void>) => {
      await fn();
    });

    const body = jest.fn().mockResolvedValue({ ok: true, id: 'abc' });

    const result = await withMongoTransaction(body);

    expect(result).toEqual({ ok: true, id: 'abc' });
    expect(body).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledWith(session);
    expect(mockEndSession).toHaveBeenCalledTimes(1);
  });

  it('ends the session even when the body throws', async () => {
    const session = makeSession();
    mockStartSession.mockResolvedValue(session);
    mockWithTransaction.mockImplementation(async (fn: () => Promise<void>) => {
      // Simulate the driver propagating the body's rejection
      await fn();
    });

    const boom = new Error('body explosion');
    const body = jest.fn().mockRejectedValue(boom);

    await expect(withMongoTransaction(body)).rejects.toThrow('body explosion');

    expect(mockEndSession).toHaveBeenCalledTimes(1);
  });

  it('ends the session even when withTransaction itself throws', async () => {
    const session = makeSession();
    mockStartSession.mockResolvedValue(session);
    mockWithTransaction.mockRejectedValue(new Error('tx aborted'));

    const body = jest.fn();

    await expect(
      withMongoTransaction(body),
    ).rejects.toThrow('tx aborted');

    expect(mockEndSession).toHaveBeenCalledTimes(1);
  });

  it('does NOT call endSession if startSession itself fails', async () => {
    // If we never got a session, there's nothing to end — and the wrapper
    // shouldn't blow up trying to end an undefined session.
    mockStartSession.mockRejectedValue(new Error('cannot start'));

    await expect(
      withMongoTransaction(jest.fn()),
    ).rejects.toThrow('cannot start');

    expect(mockEndSession).not.toHaveBeenCalled();
  });
});
