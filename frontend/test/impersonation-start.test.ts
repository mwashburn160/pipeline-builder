// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { interpretImpersonationStart } from '../src/lib/impersonation-start';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ok = (data: any, message?: string) => ({ success: true, statusCode: 200, data, message }) as any;

describe('interpretImpersonationStart', () => {
  it('treats a pending request as WAITING, not as a failure', () => {
    // Under a consent policy the call succeeds but carries no token. Reading
    // "no token" as an error would report the consent flow working as broken.
    expect(interpretImpersonationStart(ok({ requestId: 'r1', status: 'pending' }), 'failed')).toEqual({
      kind: 'waiting', requestId: 'r1', awaitingSecondAdministrator: false,
    });
  });

  it('flags when emergency access is waiting on a second administrator', () => {
    const out = interpretImpersonationStart(
      ok({ requestId: 'r1', status: 'pending', awaiting: 'second_sysadmin', reason: 'policy_denied' }), 'failed',
    );
    expect(out).toMatchObject({ kind: 'waiting', awaitingSecondAdministrator: true });
  });

  it('starts when a token was issued, keeping the request id', () => {
    expect(interpretImpersonationStart(ok({ requestId: 'r1', status: 'consumed', accessToken: 'imp.jwt' }), 'failed'))
      .toEqual({ kind: 'started', accessToken: 'imp.jwt', requestId: 'r1' });
  });

  it('reports an unsuccessful response with the server message', () => {
    const res = { success: false, statusCode: 403, message: 'Forbidden' } as any;
    expect(interpretImpersonationStart(res, 'fallback')).toEqual({ kind: 'failed', message: 'Forbidden' });
  });

  it('reports a successful response with neither a token nor a pending status as a failure', () => {
    expect(interpretImpersonationStart(ok({ requestId: 'r1', status: 'consumed' }), 'fallback'))
      .toEqual({ kind: 'failed', message: 'fallback' });
  });
});
