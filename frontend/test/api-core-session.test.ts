// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Token-refresh session semantics.
 *
 * Only a definitive rejection of the refresh token (HTTP 401/400 from
 * `/auth/refresh`) may end the session. Network errors and 5xx are an outage,
 * not a logout: they are retried with bounded backoff, and when the retries run
 * out the tokens are KEPT and the failure is surfaced as a retryable error.
 */

import { ApiCore, SESSION_REFRESH_UNAVAILABLE } from '../src/lib/api/core';
import { ApiError } from '../src/lib/api/errors';
import { REFRESH_RETRY_DELAYS_MS, REFRESH_FAILURE_COOLDOWN_MS } from '../src/lib/constants';

const FAKE_TOKENS = { accessToken: 'a.b.c', refreshToken: 'r.e.f' };
const NEW_TOKENS = { accessToken: 'x.y.z', refreshToken: 'p.q.r' };

type Refreshable = { refreshAccessToken(): Promise<boolean> };
const refresh = (core: ApiCore) => (core as unknown as Refreshable).refreshAccessToken();

function res(status: number, body: unknown = {}) {
  return { status, ok: status < 400, headers: new Headers(), json: async () => body } as unknown as Response;
}

const totalBackoff = REFRESH_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
const maxAttempts = REFRESH_RETRY_DELAYS_MS.length + 1;

describe('ApiCore token refresh', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  /** Run a refresh to completion, advancing through any backoff sleeps. */
  async function settle<T>(p: Promise<T>): Promise<T> {
    await jest.advanceTimersByTimeAsync(totalBackoff + 1);
    return p;
  }

  it.each([401, 400])('clears the session when /auth/refresh answers %i', async (status) => {
    const core = new ApiCore();
    core.setTokens(FAKE_TOKENS);
    const expired = jest.fn();
    core.onSessionExpired(expired);
    fetchMock.mockResolvedValue(res(status, { message: 'invalid refresh token' }));

    await expect(settle(refresh(core))).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1); // a rejection is final — no retry
    expect(core.getRefreshToken()).toBeNull();
    expect(localStorage.getItem('refreshToken')).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 502', () => Promise.resolve(res(502))],
    ['a 503', () => Promise.resolve(res(503))],
  ])('keeps the session through %s, retrying with bounded backoff', async (_label, impl) => {
    const core = new ApiCore();
    core.setTokens(FAKE_TOKENS);
    const expired = jest.fn();
    core.onSessionExpired(expired);
    fetchMock.mockImplementation(impl);

    await expect(settle(refresh(core))).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(maxAttempts);
    expect(core.getAccessToken()).toBe(FAKE_TOKENS.accessToken);
    expect(core.getRefreshToken()).toBe(FAKE_TOKENS.refreshToken);
    expect(localStorage.getItem('refreshToken')).toBe(FAKE_TOKENS.refreshToken);
    expect(expired).not.toHaveBeenCalled();
  });

  it('recovers when a retry succeeds after a transient failure', async () => {
    const core = new ApiCore();
    core.setTokens(FAKE_TOKENS);
    fetchMock
      .mockResolvedValueOnce(res(500))
      .mockResolvedValueOnce(res(200, { data: NEW_TOKENS }));

    await expect(settle(refresh(core))).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(core.getAccessToken()).toBe(NEW_TOKENS.accessToken);
  });

  it('backs off after giving up: no refresh storm, then retries once the cooldown ends', async () => {
    const core = new ApiCore();
    core.setTokens(FAKE_TOKENS);
    fetchMock.mockResolvedValue(res(503));
    await settle(refresh(core));
    fetchMock.mockClear();

    // Inside the cooldown: short-circuits without touching the network.
    await expect(refresh(core)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    // After the cooldown the client tries again on its own.
    fetchMock.mockResolvedValue(res(200, { data: NEW_TOKENS }));
    await jest.advanceTimersByTimeAsync(REFRESH_FAILURE_COOLDOWN_MS + 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(core.getAccessToken()).toBe(NEW_TOKENS.accessToken);
  });

  it('a new token pair (re-login) is refreshable immediately, even during a cooldown', async () => {
    const core = new ApiCore();
    core.setTokens(FAKE_TOKENS);
    fetchMock.mockResolvedValue(res(503));
    await settle(refresh(core));

    core.setTokens({ accessToken: 'l.o.g', refreshToken: 'i.n.x' });
    fetchMock.mockReset().mockResolvedValue(res(200, { data: NEW_TOKENS }));

    await expect(refresh(core)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a logout during the backoff is not undone by the in-flight refresh', async () => {
    const core = new ApiCore();
    core.setTokens(FAKE_TOKENS);
    fetchMock.mockResolvedValueOnce(res(503)).mockResolvedValue(res(200, { data: NEW_TOKENS }));

    const pending = refresh(core);
    await jest.advanceTimersByTimeAsync(0);
    core.clearTokens();

    await expect(settle(pending)).resolves.toBe(false);
    expect(core.getAccessToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adopts a pair another tab already rotated instead of presenting the stale refresh token', async () => {
    const core = new ApiCore();
    core.setTokens(FAKE_TOKENS);
    // Another tab of the same browser (same refresh-session slot) refreshed first.
    localStorage.setItem('accessToken', NEW_TOKENS.accessToken);
    localStorage.setItem('refreshToken', NEW_TOKENS.refreshToken);

    await expect(refresh(core)).resolves.toBe(true);

    // Presenting r.e.f again would be refresh-token REUSE → the server revokes the slot.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(core.getAccessToken()).toBe(NEW_TOKENS.accessToken);
    expect(core.getRefreshToken()).toBe(NEW_TOKENS.refreshToken);
  });

  it('picks up a rotation from another tab via the storage event', () => {
    const core = new ApiCore();
    core.setTokens(FAKE_TOKENS);
    localStorage.setItem('accessToken', NEW_TOKENS.accessToken);
    localStorage.setItem('refreshToken', NEW_TOKENS.refreshToken);

    window.dispatchEvent(new StorageEvent('storage', { key: 'refreshToken', newValue: NEW_TOKENS.refreshToken }));

    expect(core.getRefreshToken()).toBe(NEW_TOKENS.refreshToken);
    expect(core.getAccessToken()).toBe(NEW_TOKENS.accessToken);
  });

  it('request(): a 401 whose refresh fails transiently throws a retryable error and keeps the tokens', async () => {
    const core = new ApiCore();
    core.setTokens(FAKE_TOKENS);
    const expired = jest.fn();
    core.onSessionExpired(expired);
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith('/api/auth/refresh') ? res(503) : res(401, { message: 'jwt expired' })));

    const outcome = settle(core.request('/api/user/profile').catch((e) => e));
    const err = await outcome;

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).statusCode).toBe(503);
    expect((err as ApiError).code).toBe(SESSION_REFRESH_UNAVAILABLE);
    expect(core.getRefreshToken()).toBe(FAKE_TOKENS.refreshToken);
    expect(expired).not.toHaveBeenCalled();
  });

  it('request(): a 401 whose refresh is rejected surfaces the 401 and ends the session', async () => {
    const core = new ApiCore();
    core.setTokens(FAKE_TOKENS);
    const expired = jest.fn();
    core.onSessionExpired(expired);
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith('/api/auth/refresh') ? res(401) : res(401, { message: 'jwt expired' })));

    const err = await settle(core.request('/api/user/profile').catch((e) => e));

    expect((err as ApiError).statusCode).toBe(401);
    expect(core.getRefreshToken()).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
  });
});
