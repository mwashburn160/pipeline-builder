// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for the same-tab re-login lock-out bug.
 *
 * `refreshAttempts` counts consecutive refresh failures and is only reset on a
 * SUCCESSFUL refresh. The singleton ApiCore survives client-side navigation, so
 * a session that exhausted its refresh budget (`refreshAttempts >= MAX`) left
 * the counter pinned — a re-login in the same tab was then immediately kicked
 * out because the next refresh short-circuited on the `>= MAX` guard.
 *
 * Fix: `setTokens()` and `clearTokens()` reset the counter, so a fresh session
 * never starts pre-locked.
 */

import { ApiCore } from '../src/lib/api/core';
import { MAX_REFRESH_ATTEMPTS } from '../src/lib/constants';

const FAKE_TOKENS = { accessToken: 'a.b.c', refreshToken: 'r.e.f' };

describe('ApiCore refresh-attempt lifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('setTokens resets an exhausted refresh counter', () => {
    const core = new ApiCore();
    // Simulate a prior session that ran out of refresh budget.
    (core as unknown as { refreshAttempts: number }).refreshAttempts = MAX_REFRESH_ATTEMPTS;

    core.setTokens(FAKE_TOKENS);

    expect((core as unknown as { refreshAttempts: number }).refreshAttempts).toBe(0);
  });

  it('clearTokens resets the refresh counter', () => {
    const core = new ApiCore();
    (core as unknown as { refreshAttempts: number }).refreshAttempts = MAX_REFRESH_ATTEMPTS;

    core.clearTokens();

    expect((core as unknown as { refreshAttempts: number }).refreshAttempts).toBe(0);
  });

  it('a re-login after MAX failures is not pre-locked — the next refresh runs instead of short-circuiting', async () => {
    const core = new ApiCore();
    // Exhausted state left behind by the previous, now-expired session.
    (core as unknown as { refreshAttempts: number }).refreshAttempts = MAX_REFRESH_ATTEMPTS;

    // User signs in again in the same tab (singleton client survives nav).
    core.setTokens(FAKE_TOKENS);
    expect((core as unknown as { refreshAttempts: number }).refreshAttempts).toBe(0);

    // A refresh now actually reaches the network instead of returning false at
    // the `refreshAttempts >= MAX` guard.
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ statusCode: 200, data: { accessToken: 'x.y.z', refreshToken: 'p.q.r' } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await (core as unknown as { refreshAccessToken(): Promise<boolean> }).refreshAccessToken();

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
