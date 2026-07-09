// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import { mongoSanitize } from '../src/middleware/mongo-sanitize.js';

const run = (req: Partial<Request>) => {
  const next = jest.fn();
  mongoSanitize()(req as Request, {} as Response, next as unknown as NextFunction);
  expect(next).toHaveBeenCalledTimes(1);
};

describe('mongoSanitize', () => {
  it('strips $-operators, dot-keys, and prototype keys from body (in place)', () => {
    const req = { body: { 'email': { $ne: null }, 'a.b': 1, '__proto__': {}, 'ok': 'x' } } as unknown as Request;
    run(req);
    expect(req.body).toEqual({ email: {}, ok: 'x' });
  });

  it('sanitizes req.query even when it is an Express-5 getter (fresh object per access)', () => {
    // Simulate Express 5: `query` is a getter returning a NEW object each read.
    const req = {} as Request;
    Object.defineProperty(req, 'query', {
      configurable: true,
      enumerable: true,
      get: () => ({ email: { $ne: null }, name: 'ok' }),
    });
    run(req);
    // After the middleware, the getter must be shadowed by the sanitized snapshot
    // and stable across reads (pre-fix this returned a fresh unsanitized object).
    expect(req.query).toEqual({ email: {}, name: 'ok' });
    expect(req.query).toBe(req.query); // pinned value, not a re-parsed fresh object
  });

  it('sanitizes params in place', () => {
    const req = { params: { $where: 'bad', id: '123' } } as unknown as Request;
    run(req);
    expect(req.params).toEqual({ id: '123' });
  });
});
