// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Ending an impersonation session.
 *
 * `stopImpersonation` alone only discards the token in this browser; the session
 * stays valid on the server until its TTL. `endImpersonation` also revokes it.
 * The properties under test:
 *   - the revoke is sent under the OPERATOR's restored token, never the
 *     impersonation token (which is read-only, so a write under it is rejected);
 *   - getting out never depends on the revoke — it neither throws nor hangs.
 */

import { ApiCore } from '../src/lib/api/core';

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const IMPERSONATION_TOKEN = `h.${b64url({ sub: 'target', impersonationReadOnly: true, organizationId: 'org-t' })}.s`;
const OPERATOR = { accessToken: 'operator.access.token', refreshToken: 'operator.refresh.token' };

/** An operator signed in, who then started impersonating. */
function impersonatingCore(requestId?: string): ApiCore {
  const core = new ApiCore();
  core.setTokens(OPERATOR);
  core.startImpersonation(IMPERSONATION_TOKEN, requestId);
  return core;
}
const tokenOf = (core: ApiCore) => (core as unknown as { accessToken: string | null }).accessToken;

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
});

describe('ApiCore.endImpersonation', () => {
  it('revokes the session on the server', async () => {
    const core = impersonatingCore('req-7');
    const request = jest.spyOn(core, 'request').mockResolvedValue({} as never);

    await core.endImpersonation();

    expect(request).toHaveBeenCalledWith('/api/admin/impersonate/requests/req-7/revoke', { method: 'POST' });
  });

  it('sends the revoke under the OPERATOR token, not the impersonation token', async () => {
    const core = impersonatingCore('req-7');
    let tokenAtRevoke: string | null = null;
    jest.spyOn(core, 'request').mockImplementation(async () => {
      tokenAtRevoke = tokenOf(core);
      return {} as never;
    });

    await core.endImpersonation();

    // Under the impersonation token the write would be rejected as read-only.
    expect(tokenAtRevoke).toBe(OPERATOR.accessToken);
    expect(core.isImpersonating()).toBe(false);
  });

  it('still gets the operator out when the revoke fails', async () => {
    const core = impersonatingCore('req-7');
    jest.spyOn(core, 'request').mockRejectedValue(new Error('network down'));

    await expect(core.endImpersonation()).resolves.toBeUndefined();
    expect(tokenOf(core)).toBe(OPERATOR.accessToken);
  });

  it('does not hang when the revoke never answers', async () => {
    jest.useFakeTimers();
    const core = impersonatingCore('req-7');
    jest.spyOn(core, 'request').mockReturnValue(new Promise(() => { /* never settles */ }) as never);

    const done = core.endImpersonation();
    await jest.advanceTimersByTimeAsync(3000);

    await expect(done).resolves.toBeUndefined();
  });

  it('sends no revoke when the session has no recorded request id', async () => {
    const core = impersonatingCore(undefined);
    const request = jest.spyOn(core, 'request').mockResolvedValue({} as never);

    await core.endImpersonation();

    expect(request).not.toHaveBeenCalled();
    expect(tokenOf(core)).toBe(OPERATOR.accessToken);
  });

  it('forgets the request id, so a later stop cannot revoke a stale session', async () => {
    const core = impersonatingCore('req-7');
    jest.spyOn(core, 'request').mockResolvedValue({} as never);

    await core.endImpersonation();

    expect(sessionStorage.getItem('impersonation.requestId')).toBeNull();
  });
});
