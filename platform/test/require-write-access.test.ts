// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The read-only impersonation predicate + refusal shared by the pre-auth fence
 * (index.ts `app.use`, JWT peek) and the post-verification backstop in
 * `requireAuth`: GET/HEAD/OPTIONS pass; everything else is refused when
 * `impersonationReadOnly` is set.
 */

import { jest, describe, it, expect } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) => {
    res.status(status).json({ success: false, statusCode: status, message: msg, code });
  },
}));

const { denyReadOnlyImpersonationWrite, isWriteBlockedByImpersonation } = await import('../src/middleware/require-write-access.js');


function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('denyReadOnlyImpersonationWrite', () => {
  it('answers 403 IMPERSONATION_READ_ONLY', () => {
    const res = mockRes();
    denyReadOnlyImpersonationWrite({ method: 'POST' } as any, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect((res.json as jest.Mock<AnyFn>).mock.calls[0][0].code).toBe('IMPERSONATION_READ_ONLY');
  });
});

// Both gates share this predicate, so covering it covers both decisions and
// guarantees they can't diverge.
describe('isWriteBlockedByImpersonation (shared by the pre-auth + requireAuth gates)', () => {
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
