// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Ending an impersonation session.
 *
 * The operator's own session lives in an HttpOnly refresh cookie that starting
 * an impersonation never touches, so getting out is "drop the impersonation
 * token and refresh". `stopImpersonation` does only that — the session stays
 * valid on the server until its TTL; `endImpersonation` also revokes it.
 * The properties under test:
 *   - nothing of the operator's is stashed in web storage — only the
 *     impersonation token, tab-scoped, to survive the deliberate reload;
 *   - the revoke is sent under the OPERATOR's restored token, never the
 *     impersonation token (which is read-only, so a write under it is rejected);
 *   - getting out never depends on the revoke — it neither throws nor hangs.
 */

import { ApiCore } from '../src/lib/api/core';

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const IMPERSONATION_TOKEN = `h.${b64url({ sub: 'target', impersonationReadOnly: true, organizationId: 'org-t' })}.s`;
const OPERATOR_TOKEN = `h.${b64url({ sub: 'operator', organizationId: 'org-o', exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;

function refreshResponse() {
  return {
    status: 200,
    ok: true,
    headers: new Headers(),
    json: async () => ({ data: { accessToken: OPERATOR_TOKEN, expiresIn: 900 } }),
  } as unknown as Response;
}

/** An operator signed in, who then started impersonating. */
function impersonatingCore(requestId?: string): ApiCore {
  const core = new ApiCore();
  core.setTokens({ accessToken: OPERATOR_TOKEN });
  core.startImpersonation(IMPERSONATION_TOKEN, requestId);
  return core;
}
const tokenOf = (core: ApiCore) => (core as unknown as { accessToken: string | null }).accessToken;

beforeEach(() => {
  // Stopping picks the operator's session back up from the refresh cookie.
  global.fetch = jest.fn(async () => refreshResponse()) as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
});

describe('ApiCore.startImpersonation', () => {
  it('stashes only the impersonation token, never anything of the operator\'s', () => {
    const core = impersonatingCore('req-7');

    expect(sessionStorage.getItem('impersonation.accessToken')).toBe(IMPERSONATION_TOKEN);
    expect(sessionStorage.getItem('impersonation.originalRefresh')).toBeNull();
    expect(sessionStorage.getItem('impersonation.originalAccess')).toBeNull();
    expect(core.isImpersonating()).toBe(true);
  });

  it('survives the reload the operator is about to trigger', () => {
    impersonatingCore('req-7');

    // A fresh client in the same tab (i.e. after `window.location.href = ...`)
    // must come up still impersonating, not refreshed back into the operator's
    // own session.
    const reloaded = new ApiCore();
    expect(reloaded.isImpersonating()).toBe(true);
    expect(tokenOf(reloaded)).toBe(IMPERSONATION_TOKEN);
  });
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
    expect(tokenAtRevoke).toBe(OPERATOR_TOKEN);
    expect(core.isImpersonating()).toBe(false);
  });

  it('still gets the operator out when the revoke fails', async () => {
    const core = impersonatingCore('req-7');
    jest.spyOn(core, 'request').mockRejectedValue(new Error('network down'));

    await expect(core.endImpersonation()).resolves.toBeUndefined();
    expect(tokenOf(core)).toBe(OPERATOR_TOKEN);
  });

  it('does not hang when the revoke never answers', async () => {
    const core = impersonatingCore('req-7');
    jest.spyOn(core, 'request').mockReturnValue(new Promise(() => { /* never settles */ }) as never);
    // Fake timers only AFTER the restore refresh has been set up, so the
    // 3s revoke timeout is the only thing being advanced.
    jest.useFakeTimers();

    const done = core.endImpersonation();
    await jest.advanceTimersByTimeAsync(3000);

    await expect(done).resolves.toBeUndefined();
  });

  it('sends no revoke when the session has no recorded request id', async () => {
    const core = impersonatingCore(undefined);
    const request = jest.spyOn(core, 'request').mockResolvedValue({} as never);

    await core.endImpersonation();

    expect(request).not.toHaveBeenCalled();
    expect(tokenOf(core)).toBe(OPERATOR_TOKEN);
  });

  it('forgets the request id, so a later stop cannot revoke a stale session', async () => {
    const core = impersonatingCore('req-7');
    jest.spyOn(core, 'request').mockResolvedValue({} as never);

    await core.endImpersonation();

    expect(sessionStorage.getItem('impersonation.requestId')).toBeNull();
    expect(sessionStorage.getItem('impersonation.accessToken')).toBeNull();
  });
});
