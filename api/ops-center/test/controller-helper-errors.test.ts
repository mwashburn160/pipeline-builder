// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `handleControllerError` — the fallback every ops-center controller's
 * `withController` wrapper answers a thrown error with.
 *
 * Two contracts that must match api-server's `withRoute`:
 *  - a malformed id the database could not cast (SQLSTATE 22P02, e.g.
 *    `PUT /alert-destinations/not-a-uuid`) is the CLIENT's input: 400, not 500;
 *  - a DrizzleQueryError's message embeds the SQL and its bound parameter
 *    values, so the error object itself is never handed to the logger.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const logged = { error: jest.fn<AnyFn>(), warn: jest.fn<AnyFn>(), debug: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => logged,
  sendError: (res: any, status: number, msg: string, code?: string) => res.status(status).json({ success: false, message: msg, ...(code ? { code } : {}) }),
  recordAuthzDenial: jest.fn<AnyFn>(),
}));

const { handleControllerError, withController } = await import('../src/helpers/controller-helper.js');

function mockRes() {
  const res: any = { headersSent: false };
  res.status = jest.fn((s: number) => { res.statusCode = s; return res; });
  res.json = jest.fn((b: unknown) => { res.body = b; return res; });
  return res;
}

/** The shape drizzle throws: SQL + params in the message, the pg error on `cause`. */
function drizzleError(code: string): Error {
  const err = new Error('Failed query: select * from alert_destination where id = $1\nparams: secret-param-value');
  (err as any).cause = Object.assign(new Error('invalid input syntax for type uuid: "secret-param-value"'), { code });
  return err;
}

describe('handleControllerError', () => {
  beforeEach(() => {
    for (const fn of Object.values(logged)) fn.mockClear();
  });

  it('answers a malformed typed value (22P02) with 400, not 500', () => {
    const res = mockRes();
    handleControllerError(res, drizzleError('22P02'), '[Update alert destination] Error');
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('secret-param-value');
  });

  it('never logs the SQL or bound params of a database failure', () => {
    const res = mockRes();
    handleControllerError(res, drizzleError('23503'), '[Delete alert destination] Error');
    expect(res.statusCode).toBe(500);
    const everything = JSON.stringify([logged.error.mock.calls, logged.warn.mock.calls], (_k, v) => (v instanceof Error ? { message: v.message, cause: String(v.cause) } : v));
    expect(everything).not.toContain('secret-param-value');
    expect(everything).not.toContain('Failed query');
  });

  it('still answers a mapped domain refusal from the error map', () => {
    const res = mockRes();
    handleControllerError(res, new Error('NOPE'), 'x', { NOPE: { status: 409, message: 'conflict' } });
    expect(res.statusCode).toBe(409);
  });

  it('withController routes a thrown 22P02 to 400', async () => {
    const res = mockRes();
    await withController('Delete dashboard', async () => { throw drizzleError('22P02'); })({} as any, res);
    expect(res.statusCode).toBe(400);
  });
});
