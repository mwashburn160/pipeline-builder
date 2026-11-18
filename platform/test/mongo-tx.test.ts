// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for withMongoTransaction — the single place a transaction is opened.
 *
 * It delegates to mongoose's `connection.transaction(fn)` (which, unlike the
 * driver's bare `session.withTransaction`, resets the mongoose state of
 * documents saved in an attempt whose body threw before the retry). Mongoose
 * is mocked here — we validate the wrapper's contract: the session is handed
 * to the body, the BODY's return value (not the commit result) comes back,
 * and errors propagate unchanged. The real retry/reset behaviour is proven
 * against a replica set in test/mongo-tx.integration.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

const mockTransaction = jest.fn<(fn: (s: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown>>();

jest.unstable_mockModule('mongoose', () => ({
  __esModule: true,
  default: {
    connection: { transaction: (fn: (s: unknown) => Promise<unknown>, opts?: unknown) => mockTransaction(fn, opts) },
  },
}));

const { withMongoTransaction } = await import('../src/utils/mongo-tx.js');

const session = { id: 'session' };

describe('withMongoTransaction', () => {
  beforeEach(() => {
    mockTransaction.mockReset();
  });

  it('runs the body through connection.transaction with the session and returns the BODY result', async () => {
    // connection.transaction resolves to the driver's commit result — the
    // wrapper must return what the body returned instead.
    mockTransaction.mockImplementation(async (fn) => { await fn(session); return { ok: 1 }; });
    const body = jest.fn<AnyFn>().mockResolvedValue({ ok: true, id: 'abc' });

    const result = await withMongoTransaction(body);

    expect(result).toEqual({ ok: true, id: 'abc' });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledWith(session);
  });

  it('returns the result of the LAST attempt when the body is retried', async () => {
    mockTransaction.mockImplementation(async (fn) => {
      await fn(session).catch(() => undefined); // attempt 1 aborted
      await fn(session); // attempt 2 commits
      return { ok: 1 };
    });
    let attempt = 0;
    const body = jest.fn<AnyFn>().mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('write conflict'), { errorLabels: ['TransientTransactionError'] });
      return `attempt-${attempt}`;
    });

    await expect(withMongoTransaction(body)).resolves.toBe('attempt-2');
    expect(body).toHaveBeenCalledTimes(2);
  });

  it('propagates the body rejection unchanged', async () => {
    mockTransaction.mockImplementation(async (fn) => fn(session));
    const boom = new Error('body explosion');

    await expect(withMongoTransaction(jest.fn<AnyFn>().mockRejectedValue(boom))).rejects.toBe(boom);
  });

  it('propagates a commit / session-start failure from connection.transaction', async () => {
    mockTransaction.mockRejectedValue(new Error('tx aborted'));
    const body = jest.fn<AnyFn>();

    await expect(withMongoTransaction(body)).rejects.toThrow('tx aborted');
    expect(body).not.toHaveBeenCalled();
  });
});
