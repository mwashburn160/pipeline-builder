// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the `requireWriteAccess` middleware — the read-only
 * impersonation gate. The shipped version of this gate lives in
 * platform/src/index.ts as an inline `app.use` that does a JWT-peek;
 * `require-write-access.ts` is the per-route alternative that operates
 * on `req.user` already populated by `requireAuth`. Both must enforce
 * the same contract: GET/HEAD/OPTIONS pass through; everything else is
 * rejected when `impersonationReadOnly` is set.
 */

jest.mock('@pipeline-builder/api-core', () => ({
  sendError: (res: any, status: number, msg: string, code?: string) => {
    res.status(status).json({ success: false, statusCode: status, message: msg, code });
  },
}));

import { requireWriteAccess, isWriteBlockedByImpersonation } from '../src/middleware/require-write-access';

function mockReq(method: string, impersonationReadOnly?: boolean) {
  return {
    method,
    user: impersonationReadOnly === undefined
      ? undefined
      : { sub: 'u1', impersonationReadOnly },
  } as any;
}

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('requireWriteAccess', () => {
  it('passes GET through under impersonation', () => {
    const next = jest.fn();
    requireWriteAccess(mockReq('GET', true), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('passes HEAD and OPTIONS through under impersonation', () => {
    const head = jest.fn();
    const opt = jest.fn();
    requireWriteAccess(mockReq('HEAD', true), mockRes(), head);
    requireWriteAccess(mockReq('OPTIONS', true), mockRes(), opt);
    expect(head).toHaveBeenCalled();
    expect(opt).toHaveBeenCalled();
  });

  it('rejects POST/PUT/PATCH/DELETE under impersonation', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = mockRes();
      const next = jest.fn();
      requireWriteAccess(mockReq(method, true), res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect((res.json as jest.Mock).mock.calls[0][0].code).toBe('IMPERSONATION_READ_ONLY');
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('passes writes through when NOT impersonating (impersonationReadOnly false)', () => {
    const next = jest.fn();
    requireWriteAccess(mockReq('POST', false), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('passes writes through for unauthenticated requests (no req.user)', () => {
    // requireWriteAccess relies on requireAuth running first; if it didn't,
    // we let the request through and requireAuth (or its absence) will
    // reject it elsewhere.
    const next = jest.fn();
    requireWriteAccess(mockReq('POST'), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });
});

// The SHIPPED gate is the inline app.use in index.ts (a pre-auth JWT-peek). It
// now shares this predicate, so covering the predicate covers both gates'
// decision and guarantees they can't diverge.
describe('isWriteBlockedByImpersonation (shared by the shipped + per-route gates)', () => {
  it('blocks writes only when impersonationReadOnly is true', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isWriteBlockedByImpersonation(m, true)).toBe(true);
      expect(isWriteBlockedByImpersonation(m, false)).toBe(false);
      expect(isWriteBlockedByImpersonation(m, undefined)).toBe(false);
    }
  });

  it('never blocks read methods, even under read-only impersonation', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      expect(isWriteBlockedByImpersonation(m, true)).toBe(false);
    }
  });
});
