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
 *    because the refresh token is an HttpOnly cookie no tab can read.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { ApiCore, SESSION_REFRESH_UNAVAILABLE } from '../src/lib/api/core';
import { ApiError } from '../src/lib/api/errors';
import { REFRESH_RETRY_DELAYS_MS, REFRESH_FAILURE_COOLDOWN_MS, REFRESH_REQUEST_TIMEOUT_MS, REFRESH_LOCK_WAIT_MS } from '../src/lib/constants';

/** A decodable access token whose `exp` is `secondsFromNow` out. */
function accessToken(sub: string, secondsFromNow = 3600, organizationId = 'org-1'): string {
  const body = { sub, organizationId, exp: Math.floor(Date.now() / 1000) + secondsFromNow };
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
  let fetchMock: jest.Mock<AnyFn>;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn<AnyFn>();
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
    const expired = jest.fn<AnyFn>();
    core.onSessionExpired(expired);
    fetchMock.mockResolvedValue(res(status, { message: 'invalid refresh token' }));

    await expect(settle(refresh(core))).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1); // a rejection is final — no retry
    expect(core.getAccessToken()).toBeNull();
    expect(localStorage.getItem('pb.session')).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('names the reason when /auth/refresh answers 401 SESSION_EXPIRED (the session outlived its policy)', async () => {
    const core = signedInCore();
    const expired = jest.fn<AnyFn>();
    core.onSessionExpired(expired);
    fetchMock.mockResolvedValue(res(401, { code: 'SESSION_EXPIRED', message: 'Your session has expired — please sign in again' }));

    await expect(settle(refresh(core))).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(core.getAccessToken()).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledWith('session-expired');
  });

  it.each([
    ['another 401 code', 401, { code: 'REFRESH_TOKEN_REUSED' }],
    ['a 400 carrying SESSION_EXPIRED', 400, { code: 'SESSION_EXPIRED' }],
    ['a 401 without a JSON body', 401, undefined],
  ])('a generic rejection (%s) ends the session without a reason', async (_label, status, body) => {
    const core = signedInCore();
    const expired = jest.fn<AnyFn>();
    core.onSessionExpired(expired);
    fetchMock.mockResolvedValue(body === undefined
      ? ({ ok: false, status, headers: new Headers(), json: () => Promise.reject(new SyntaxError('no body')) } as unknown as Response)
      : res(status, body));

    await expect(settle(refresh(core))).resolves.toBe(false);

    expect(core.getAccessToken()).toBeNull();
    expect(expired).toHaveBeenCalledWith(undefined);
  });

  it.each([
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 502', () => Promise.resolve(res(502))],
    ['a 503', () => Promise.resolve(res(503))],
  ])('keeps the session through %s, retrying with bounded backoff', async (_label, impl) => {
    const core = signedInCore();
    const expired = jest.fn<AnyFn>();
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

  it('a logout while the refresh request is out is not undone when it lands', async () => {
    const core = signedInCore();
    let answer!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { answer = r; }));

    const pending = refresh(core);
    await jest.advanceTimersByTimeAsync(0);
    core.clearTokens();
    answer(res(200, { data: ROTATED }));

    await expect(settle(pending)).resolves.toBe(false);
    expect(core.getAccessToken()).toBeNull();
    expect(localStorage.getItem('pb.session')).toBeNull();
  });

  it('request(): a 401 whose refresh fails transiently throws a retryable error and keeps the session', async () => {
    const core = signedInCore();
    const expired = jest.fn<AnyFn>();
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
    const expired = jest.fn<AnyFn>();
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

describe('ApiCore request(): a 401 that lands across an identity change', () => {
  let fetchMock: jest.Mock<AnyFn>;
  const NEW_SESSION = { accessToken: accessToken('u2', 3600, 'org-2') };
  const IMPERSONATION = accessToken('target', 3600, 'org-t');

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn<AnyFn>();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  const authOf = (call: unknown[]) =>
    ((call[1] as RequestInit).headers as Record<string, string>).Authorization;

  /**
   * The first call 401s; the refresh it triggers is held open until `change`
   * runs (an identity change), then lands — and is dropped, because the
   * session generation moved. Every later non-refresh call answers `after`.
   */
  function scenario(core: ApiCore, change: () => void, after: Response = res(200, { success: true, data: { ok: 1 } })) {
    let landRefresh!: (r: Response) => void;
    let first = true;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/api/auth/refresh')) {
        return new Promise<Response>((r) => { landRefresh = (x) => { change(); r(x); }; });
      }
      if (first) { first = false; return Promise.resolve(res(401, { message: 'jwt expired' })); }
      return Promise.resolve(after);
    });
    return () => landRefresh(res(200, { data: ROTATED }));
  }

  async function run<T>(p: Promise<T>, land: () => void): Promise<T> {
    await jest.advanceTimersByTimeAsync(0);
    land();
    await jest.advanceTimersByTimeAsync(totalBackoff + 1);
    return p;
  }

  it('retries a GET once with the token that is now current (new sign-in / org switch)', async () => {
    const core = signedInCore();
    const land = scenario(core, () => core.setTokens(NEW_SESSION));

    await expect(run(core.request('/api/pipelines'), land)).resolves.toEqual({ success: true, data: { ok: 1 } });

    const calls = fetchMock.mock.calls.filter(([u]) => !(u as string).endsWith('/api/auth/refresh'));
    expect(calls).toHaveLength(2);
    expect(authOf(calls[0])).toBe(`Bearer ${FIRST.accessToken}`);
    expect(authOf(calls[1])).toBe(`Bearer ${NEW_SESSION.accessToken}`);
    // The dropped refresh never displaced the new session.
    expect(core.getAccessToken()).toBe(NEW_SESSION.accessToken);
  });

  it('retries a GET with the impersonation token when impersonation started mid-refresh', async () => {
    const core = signedInCore();
    const land = scenario(core, () => core.startImpersonation(IMPERSONATION));

    await expect(run(core.request('/api/pipelines'), land)).resolves.toEqual({ success: true, data: { ok: 1 } });

    const last = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(authOf(last)).toBe(`Bearer ${IMPERSONATION}`);
  });

  it('retries only once: a second 401 under the current token surfaces as itself', async () => {
    const core = signedInCore();
    const land = scenario(core, () => core.setTokens(NEW_SESSION), res(401, { message: 'nope' }));

    const err = await run(core.request('/api/pipelines').catch((e) => e), land);

    expect((err as ApiError).statusCode).toBe(401);
    // original + refresh + one retry — no second refresh, no loop.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never re-issues a mutation under a different identity: keeps the retryable refresh error', async () => {
    const core = signedInCore();
    const land = scenario(core, () => core.setTokens(NEW_SESSION));

    const err = await run(core.request('/api/pipelines', { method: 'POST', body: '{}' }).catch((e) => e), land);

    expect((err as ApiError).statusCode).toBe(503);
    expect((err as ApiError).code).toBe(SESSION_REFRESH_UNAVAILABLE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry after a logout: no token, the 401 surfaces', async () => {
    const core = signedInCore();
    const land = scenario(core, () => core.clearTokens());

    const err = await run(core.request('/api/pipelines').catch((e) => e), land);

    expect((err as ApiError).statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(core.getAccessToken()).toBeNull();
  });

  it('keeps today\'s behaviour when the token did not change (a plain transient refresh failure)', async () => {
    const core = signedInCore();
    // Bump the generation without changing the token: the refresh is dropped,
    // but there is no newer credential to retry with.
    const land = scenario(core, () => core.setTokens(FIRST));

    const err = await run(core.request('/api/pipelines').catch((e) => e), land);

    expect((err as ApiError).code).toBe(SESSION_REFRESH_UNAVAILABLE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('ApiCore.restoreSession', () => {
  let fetchMock: jest.Mock<AnyFn>;

  beforeEach(() => {
    fetchMock = jest.fn<AnyFn>();
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

/**
 * A page load must never wait forever on the refresh. Both waits are inside the
 * cross-tab Web Lock: the request itself, and — for every OTHER tab — the lock.
 * A refresh request that never settled once left every new tab on its
 * "Verifying…" spinner, with no request ever sent.
 */
describe('ApiCore refresh is bounded', () => {
  let fetchMock: jest.Mock<AnyFn>;
  const hadLocks = 'locks' in navigator;

  /** Stand in for navigator.locks (jsdom ships none). */
  function stubLocks(request: (name: string, opts: { signal?: AbortSignal }, fn: () => Promise<boolean>) => Promise<boolean>) {
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  }

  /** A fetch that only ever ends by being aborted — the hung request. */
  function hangingFetch(_url: unknown, init?: RequestInit): Promise<Response> {
    return new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn<AnyFn>();
    global.fetch = fetchMock as unknown as typeof fetch;
    localStorage.setItem('pb.session', '1');
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (!hadLocks) delete (navigator as unknown as Record<string, unknown>).locks;
    localStorage.clear();
    sessionStorage.clear();
  });

  it('abandons a refresh request that never settles, retries it, and keeps the session', async () => {
    fetchMock.mockImplementation(hangingFetch as AnyFn);
    const core = new ApiCore();

    const done = core.restoreSession();
    await jest.advanceTimersByTimeAsync(REFRESH_REQUEST_TIMEOUT_MS * maxAttempts + totalBackoff + 1);

    await expect(done).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(maxAttempts);
    // A timeout is an outage, not a verdict on the cookie.
    expect(localStorage.getItem('pb.session')).toBe('1');
  });

  it('gives up waiting on a lock another tab never releases, instead of spinning forever', async () => {
    // The holder never lets go: the request callback is never run.
    stubLocks((_name, opts) => new Promise((_, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const core = new ApiCore();

    const done = core.restoreSession();
    await jest.advanceTimersByTimeAsync(REFRESH_LOCK_WAIT_MS + 1);

    await expect(done).resolves.toBe(false);
    // Nothing was sent: presenting the cookie behind a stuck holder risks a reuse revocation.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('pb.session')).toBe('1');
  });

  it('still refreshes normally under the lock, and waits longer than a healthy holder can take', async () => {
    let lockOpts: { signal?: AbortSignal } | undefined;
    stubLocks((_name, opts, fn) => { lockOpts = opts; return fn(); });
    fetchMock.mockResolvedValue(res(200, { data: ROTATED }));
    const core = new ApiCore();

    await expect(core.restoreSession()).resolves.toBe(true);
    expect(core.getAccessToken()).toBe(ROTATED.accessToken);
    expect(lockOpts?.signal).toBeDefined();
    expect(REFRESH_LOCK_WAIT_MS).toBeGreaterThan(REFRESH_REQUEST_TIMEOUT_MS * maxAttempts + totalBackoff);
  });
});

describe('ApiCore cross-tab coordination', () => {
  let fetchMock: jest.Mock<AnyFn>;

  beforeEach(() => {
    fetchMock = jest.fn<AnyFn>();
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

  it('tells the other tabs when the shared session moved to another org', () => {
    const tabA = new ApiCore();
    const tabB = new ApiCore();
    tabA.setTokens(FIRST);
    const orgChangedInB = jest.fn<AnyFn>();
    tabB.onOrganizationChange(orgChangedInB);

    // A same-org rotation is not an org change.
    tabA.setTokens(ROTATED);
    expect(orgChangedInB).not.toHaveBeenCalled();

    tabA.setTokens({ accessToken: accessToken('u1', 3600, 'org-2') });
    expect(tabB.getOrganizationId()).toBe('org-2');
    expect(orgChangedInB).toHaveBeenCalledTimes(1);
  });

  it('signs the other tabs out when one of them ends the session', () => {
    const tabA = new ApiCore();
    const tabB = new ApiCore();
    tabA.setTokens(FIRST);
    const expiredInB = jest.fn<AnyFn>();
    tabB.onSessionExpired(expiredInB);

    tabA.clearTokens();

    expect(tabB.getAccessToken()).toBeNull();
    expect(expiredInB).toHaveBeenCalledTimes(1);
  });
});

describe('ApiCore refresh cooldown and storage fallback', () => {
  let fetchMock: jest.Mock<AnyFn>;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn<AnyFn>();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  function throttled(retryAfterSeconds: number) {
    return { status: 429, ok: false, headers: new Headers({ 'Retry-After': String(retryAfterSeconds) }), json: async () => ({}) } as unknown as Response;
  }

  it('a 429 waits out the full Retry-After before the automatic retry, not just the failure cooldown', async () => {
    const core = signedInCore();
    const waitMs = REFRESH_FAILURE_COOLDOWN_MS * 4;
    fetchMock.mockResolvedValueOnce(throttled(waitMs / 1000)).mockResolvedValue(res(200, { data: ROTATED }));

    await expect(refresh(core)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The ordinary cooldown has passed, but the server asked for longer.
    await jest.advanceTimersByTimeAsync(REFRESH_FAILURE_COOLDOWN_MS + 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(waitMs - REFRESH_FAILURE_COOLDOWN_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(core.getAccessToken()).toBe(ROTATED.accessToken);
  });

  it('a 429 with a short Retry-After still waits the minimum failure cooldown', async () => {
    const core = signedInCore();
    fetchMock.mockResolvedValueOnce(throttled(1)).mockResolvedValue(res(200, { data: ROTATED }));

    await refresh(core);
    await jest.advanceTimersByTimeAsync(REFRESH_FAILURE_COOLDOWN_MS - 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(20);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('when localStorage throws', () => {
    beforeEach(() => {
      jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('SecurityError'); });
      jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('SecurityError'); });
    });

    it('a signed-in session stays refreshable from memory', async () => {
      const core = signedInCore();
      fetchMock.mockResolvedValue(res(200, { data: ROTATED }));
      await expect(refresh(core)).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(core.getAccessToken()).toBe(ROTATED.accessToken);
    });

    it('a rejected refresh still ends the session with onSessionExpired, not a bare 401', async () => {
      const core = signedInCore();
      const expired = jest.fn<AnyFn>();
      core.onSessionExpired(expired);
      fetchMock.mockResolvedValue(res(401));
      await expect(refresh(core)).resolves.toBe(false);
      expect(expired).toHaveBeenCalledTimes(1);
      expect(core.getAccessToken()).toBeNull();
    });

    it('sign-out clears the in-memory marker: no refresh afterwards', async () => {
      const core = signedInCore();
      core.clearTokens();
      await expect(refresh(core)).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('with working storage, a sibling clearing the shared marker still stops refreshes', async () => {
    const core = signedInCore();
    localStorage.removeItem('pb.session');
    await expect(refresh(core)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
