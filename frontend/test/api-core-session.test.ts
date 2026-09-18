// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Token-refresh session semantics, now that the refresh token is an HttpOnly
 * cookie no script can read.
 *
 * Three properties under test:
 *  - the refresh token never passes through JavaScript: `/auth/refresh` is
 *    called with no credential in the body, the cookie is attached by the
 *    browser, and nothing token-shaped is ever written to storage;
 *  - only a definitive rejection (HTTP 401/400 from `/auth/refresh`) may end
 *    the session — network errors and 5xx are an outage, retried with bounded
 *    backoff, and when the retries run out the session is KEPT;
 *  - tabs coordinate by sharing the new ACCESS token over a BroadcastChannel,
 *    because the refresh token they used to hand each other is now unreadable.
 */

import { ApiCore, SESSION_REFRESH_UNAVAILABLE } from '../src/lib/api/core';
import { ApiError } from '../src/lib/api/errors';
import { REFRESH_RETRY_DELAYS_MS, REFRESH_FAILURE_COOLDOWN_MS } from '../src/lib/constants';

/** A decodable access token whose `exp` is `secondsFromNow` out. */
function accessToken(sub: string, secondsFromNow = 3600): string {
  const body = { sub, organizationId: 'org-1', exp: Math.floor(Date.now() / 1000) + secondsFromNow };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `h.${payload}.s`;
}

const FIRST = { accessToken: accessToken('u1') };
const ROTATED = { accessToken: accessToken('u1-rotated') };

type Refreshable = { refreshAccessToken(): Promise<boolean> };
const refresh = (core: ApiCore) => (core as unknown as Refreshable).refreshAccessToken();

function res(status: number, body: unknown = {}) {
  return { status, ok: status < 400, headers: new Headers(), json: async () => body } as unknown as Response;
}

/**
 * Minimal BroadcastChannel (jsdom ships none): every channel of the same name
 * delivers to its peers, never to itself — like the real one.
 */
class TestBroadcastChannel {
  static peers = new Map<string, Set<TestBroadcastChannel>>();
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(public readonly name: string) {
    const set = TestBroadcastChannel.peers.get(name) ?? new Set();
    set.add(this);
    TestBroadcastChannel.peers.set(name, set);
  }

  postMessage(data: unknown): void {
    for (const peer of TestBroadcastChannel.peers.get(this.name) ?? []) {
      if (peer !== this) peer.onmessage?.({ data } as MessageEvent);
    }
  }

  close(): void {
    TestBroadcastChannel.peers.get(this.name)?.delete(this);
  }
}

const totalBackoff = REFRESH_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
const maxAttempts = REFRESH_RETRY_DELAYS_MS.length + 1;

/** A client whose browser already holds a refresh cookie. */
function signedInCore(): ApiCore {
  const core = new ApiCore();
  core.setTokens(FIRST);
  return core;
}

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

  it('presents only the cookie: no refresh token in the body, CSRF header set', async () => {
    const core = signedInCore();
    fetchMock.mockResolvedValue(res(200, { data: ROTATED }));

    await expect(settle(refresh(core))).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/refresh');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['X-Pb-Client']).toBe('web');
    // The whole point: the credential is the cookie, never anything a script held.
    expect(init.body).toBe('{}');
    expect(core.getAccessToken()).toBe(ROTATED.accessToken);
  });

  it('never writes a token to storage — only the non-secret session marker', () => {
    const core = signedInCore();

    expect(localStorage.getItem('pb.session')).toBe('1');
    const stored = Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? '');
    expect(stored).not.toContain(FIRST.accessToken);
    expect(core.getAccessToken()).toBe(FIRST.accessToken);
  });

  it.each([401, 400])('clears the session when /auth/refresh answers %i', async (status) => {
    const core = signedInCore();
    const expired = jest.fn();
    core.onSessionExpired(expired);
    fetchMock.mockResolvedValue(res(status, { message: 'invalid refresh token' }));

    await expect(settle(refresh(core))).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1); // a rejection is final — no retry
    expect(core.getAccessToken()).toBeNull();
    expect(localStorage.getItem('pb.session')).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 502', () => Promise.resolve(res(502))],
    ['a 503', () => Promise.resolve(res(503))],
  ])('keeps the session through %s, retrying with bounded backoff', async (_label, impl) => {
    const core = signedInCore();
    const expired = jest.fn();
    core.onSessionExpired(expired);
    fetchMock.mockImplementation(impl);

    await expect(settle(refresh(core))).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(maxAttempts);
    expect(core.getAccessToken()).toBe(FIRST.accessToken);
    expect(localStorage.getItem('pb.session')).toBe('1');
    expect(expired).not.toHaveBeenCalled();
  });

  it('recovers when a retry succeeds after a transient failure', async () => {
    const core = signedInCore();
    fetchMock
      .mockResolvedValueOnce(res(500))
      .mockResolvedValueOnce(res(200, { data: ROTATED }));

    await expect(settle(refresh(core))).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(core.getAccessToken()).toBe(ROTATED.accessToken);
  });

  it('backs off after giving up: no refresh storm, then retries once the cooldown ends', async () => {
    const core = signedInCore();
    fetchMock.mockResolvedValue(res(503));
    await settle(refresh(core));
    fetchMock.mockClear();

    // Inside the cooldown: short-circuits without touching the network.
    await expect(refresh(core)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    // After the cooldown the client tries again on its own.
    fetchMock.mockResolvedValue(res(200, { data: ROTATED }));
    await jest.advanceTimersByTimeAsync(REFRESH_FAILURE_COOLDOWN_MS + 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(core.getAccessToken()).toBe(ROTATED.accessToken);
  });

  it('a new session (re-login) is refreshable immediately, even during a cooldown', async () => {
    const core = signedInCore();
    fetchMock.mockResolvedValue(res(503));
    await settle(refresh(core));

    core.setTokens({ accessToken: accessToken('u1-relogin') });
    fetchMock.mockReset().mockResolvedValue(res(200, { data: ROTATED }));

    await expect(refresh(core)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a logout during the backoff is not undone by the in-flight refresh', async () => {
    const core = signedInCore();
    fetchMock.mockResolvedValueOnce(res(503)).mockResolvedValue(res(200, { data: ROTATED }));

    const pending = refresh(core);
    await jest.advanceTimersByTimeAsync(0);
    core.clearTokens();

    await expect(settle(pending)).resolves.toBe(false);
    expect(core.getAccessToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('request(): a 401 whose refresh fails transiently throws a retryable error and keeps the session', async () => {
    const core = signedInCore();
    const expired = jest.fn();
    core.onSessionExpired(expired);
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith('/api/auth/refresh') ? res(503) : res(401, { message: 'jwt expired' })));

    const outcome = settle(core.request('/api/user/profile').catch((e) => e));
    const err = await outcome;

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).statusCode).toBe(503);
    expect((err as ApiError).code).toBe(SESSION_REFRESH_UNAVAILABLE);
    expect(localStorage.getItem('pb.session')).toBe('1');
    expect(expired).not.toHaveBeenCalled();
  });

  it('request(): a 401 whose refresh is rejected surfaces the 401 and ends the session', async () => {
    const core = signedInCore();
    const expired = jest.fn();
    core.onSessionExpired(expired);
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith('/api/auth/refresh') ? res(401) : res(401, { message: 'jwt expired' })));

    const err = await settle(core.request('/api/user/profile').catch((e) => e));

    expect((err as ApiError).statusCode).toBe(401);
    expect(core.getAccessToken()).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('request(): tags every call with the client-type header', async () => {
    const core = signedInCore();
    fetchMock.mockResolvedValue(res(200, { success: true, data: {} }));

    await core.request('/api/user/profile');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Pb-Client']).toBe('web');
  });
});

describe('ApiCore.restoreSession', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('reloads the access token from the refresh cookie', async () => {
    // A signed-in browser that just reloaded: marker present, memory empty.
    localStorage.setItem('pb.session', '1');
    const core = new ApiCore();
    expect(core.isAuthenticated()).toBe(false);
    fetchMock.mockResolvedValue(res(200, { data: ROTATED }));

    await expect(core.restoreSession()).resolves.toBe(true);
    expect(core.getAccessToken()).toBe(ROTATED.accessToken);
  });

  it('does not probe the server for a visitor who was never signed in', async () => {
    const core = new ApiCore();

    await expect(core.restoreSession()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports signed out when the cookie is no longer accepted', async () => {
    localStorage.setItem('pb.session', '1');
    const core = new ApiCore();
    fetchMock.mockResolvedValue(res(401));

    await expect(core.restoreSession()).resolves.toBe(false);
    expect(localStorage.getItem('pb.session')).toBeNull();
  });
});

describe('ApiCore cross-tab coordination', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = TestBroadcastChannel;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    TestBroadcastChannel.peers.clear();
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    localStorage.clear();
    sessionStorage.clear();
  });

  it('shares the new ACCESS token with the other tabs, so they need no refresh of their own', async () => {
    const tabA = new ApiCore();
    const tabB = new ApiCore();
    tabA.setTokens(FIRST);
    fetchMock.mockResolvedValue(res(200, { data: ROTATED }));

    await refresh(tabA);

    // Tab B never touched the cookie; it took the token tab A minted. Presenting
    // the cookie again would rotate it a second time for nothing.
    expect(tabB.getAccessToken()).toBe(ROTATED.accessToken);
    fetchMock.mockClear();
    await tabB.ensureFreshToken();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs the other tabs out when one of them ends the session', () => {
    const tabA = new ApiCore();
    const tabB = new ApiCore();
    tabA.setTokens(FIRST);
    const expiredInB = jest.fn();
    tabB.onSessionExpired(expiredInB);

    tabA.clearTokens();

    expect(tabB.getAccessToken()).toBeNull();
    expect(expiredInB).toHaveBeenCalledTimes(1);
  });
});
