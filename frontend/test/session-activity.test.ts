// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Inactivity sign-out, the client half that never renders anything:
 *
 *  - the ACTIVITY TRACKER counts only real input (pointer, key, touch, wheel —
 *    never a scroll, which code causes too), throttled, shared with every tab of the browser over a
 *    BroadcastChannel — or the `storage` event where there is none;
 *  - the API client reports it: `/auth/refresh` says `activity: 'user'` only
 *    when there was input since the session's last recorded activity, and
 *    `'passive'` otherwise — so a polling tab nobody touches still times out;
 *  - the client keeps the session's idle state (effective timeout + deadline)
 *    from every token delivery, shares it with the other tabs, and an idle
 *    `SESSION_EXPIRED` (or an idle sign-out in one tab) ends the session in
 *    every tab with the reason attached.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { ApiCore } from '../src/lib/api/core';
import { ActivityTracker, ACTIVITY_THROTTLE_MS, activityTracker } from '../src/lib/session/activity';

const MINUTE = 60_000;

/** A decodable access token minted "now" (iat) that expires `secondsFromNow` out. */
function accessToken(sub: string, secondsFromNow = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { sub, organizationId: 'org-1', iat: now, exp: now + secondsFromNow };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `h.${payload}.s`;
}

/** The `session` block the platform returns with an interactive token. */
const idleState = (lastActiveAgoMs: number, minutes = 15) => ({
  idleTimeoutMinutes: minutes,
  idleExpiresAt: new Date(Date.now() - lastActiveAgoMs + minutes * MINUTE).toISOString(),
});

function res(status: number, body: unknown = {}) {
  return { status, ok: status < 400, headers: new Headers(), json: async () => body } as unknown as Response;
}

/** jsdom ships no BroadcastChannel: every same-name channel delivers to its peers, never itself. */
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
  close(): void { TestBroadcastChannel.peers.get(this.name)?.delete(this); }
}

type Refreshable = { refreshAccessToken(): Promise<boolean> };
const refresh = (core: ApiCore) => (core as unknown as Refreshable).refreshAccessToken();
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

const input = (type = 'pointerdown') => window.dispatchEvent(new Event(type));

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
  TestBroadcastChannel.peers.clear();
  delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
  localStorage.clear();
});

describe('ActivityTracker', () => {
  it('does not count a scroll: code scrolls too (a live log tail, a streaming answer), and a person\'s scroll arrives as wheel, touch, key or pointer input', () => {
    const t = new ActivityTracker();
    const stop = t.start();
    input('scroll');
    expect(t.lastActivityAt()).toBe(0);
    stop();
  });

  it.each(['pointermove', 'pointerdown', 'keydown', 'touchstart', 'wheel'])('counts %s as real input', (type) => {
    const t = new ActivityTracker();
    const stop = t.start();
    expect(t.lastActivityAt()).toBe(0);
    input(type);
    expect(t.lastActivityAt()).toBe(Date.now());
    stop();
  });

  it('is throttled: a burst of input records once, the next window records again', () => {
    const t = new ActivityTracker();
    const seen = jest.fn<AnyFn>();
    const stop = t.start();
    t.subscribe(seen);
    input();
    const first = t.lastActivityAt();
    jest.advanceTimersByTime(1000);
    input('pointermove');
    input('keydown');
    expect(t.lastActivityAt()).toBe(first);
    expect(seen).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(ACTIVITY_THROTTLE_MS);
    input();
    expect(t.lastActivityAt()).toBe(Date.now());
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
  });

  it('ignores ambient input while suspended (the warning is up), but an explicit record still counts', () => {
    const t = new ActivityTracker();
    const stop = t.start();
    t.setSuspended(true);
    input();
    expect(t.lastActivityAt()).toBe(0);
    t.record();
    expect(t.lastActivityAt()).toBe(Date.now());
    stop();
  });

  it('stops listening when stopped', () => {
    const t = new ActivityTracker();
    t.start()();
    input();
    expect(t.lastActivityAt()).toBe(0);
  });

  it('shares activity with the other tabs over a BroadcastChannel', () => {
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = TestBroadcastChannel;
    const tabA = new ActivityTracker();
    const tabB = new ActivityTracker();
    const stopA = tabA.start();
    const stopB = tabB.start();
    const seenInB = jest.fn<AnyFn>();
    tabB.subscribe(seenInB);
    tabA.record();
    expect(tabB.lastActivityAt()).toBe(Date.now());
    expect(seenInB).toHaveBeenCalledWith(Date.now());
    stopA(); stopB();
  });

  it('falls back to the storage event where there is no BroadcastChannel', () => {
    const tabB = new ActivityTracker();
    const stop = tabB.start();
    const at = Date.now() - 1000;
    window.dispatchEvent(new StorageEvent('storage', { key: 'pb.activity', newValue: String(at) }));
    expect(tabB.lastActivityAt()).toBe(at);
    // An older value never moves it backwards; junk is ignored.
    window.dispatchEvent(new StorageEvent('storage', { key: 'pb.activity', newValue: String(at - 5000) }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'pb.activity', newValue: 'nope' }));
    expect(tabB.lastActivityAt()).toBe(at);
    stop();
  });

  it('a new page starts from the activity another tab stored', () => {
    const at = Date.now() - 2000;
    localStorage.setItem('pb.activity', String(at));
    const t = new ActivityTracker();
    const stop = t.start();
    expect(t.lastActivityAt()).toBe(at);
    stop();
  });
});

describe('ApiCore reports activity on refresh', () => {
  let fetchMock: jest.Mock<AnyFn>;
  let stopTracker: () => void;

  beforeEach(() => {
    fetchMock = jest.fn<AnyFn>();
    global.fetch = fetchMock as unknown as typeof fetch;
    stopTracker = activityTracker.start();
    activityTracker.resetForTests();
  });

  afterEach(() => stopTracker());

  /** A client signed in 1 minute ago (its sign-in is the session's last activity). */
  function signedIn(): ApiCore {
    const core = new ApiCore();
    core.setTokens({ accessToken: accessToken('u1'), session: idleState(MINUTE) });
    return core;
  }

  it('a refresh with no input since the last activity is PASSIVE', async () => {
    const core = signedIn();
    fetchMock.mockResolvedValue(res(200, { data: { accessToken: accessToken('u1'), session: idleState(MINUTE) } }));
    await refresh(core);
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ activity: 'passive' });
  });

  it('polling never counts as activity: many API calls, still a passive refresh', async () => {
    const core = signedIn();
    fetchMock.mockResolvedValue(res(200, { success: true, data: {} }));
    for (let i = 0; i < 5; i++) {
      await core.request('/api/builds/queue');
      jest.advanceTimersByTime(30_000);
    }
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(res(200, { data: { accessToken: accessToken('u1'), session: idleState(4 * MINUTE) } }));
    await refresh(core);
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ activity: 'passive' });
  });

  it('a refresh after real input is USER — and only once: the next one, with no new input, is passive', async () => {
    const core = signedIn();
    jest.advanceTimersByTime(10_000);
    input('keydown');
    fetchMock.mockResolvedValueOnce(res(200, { data: { accessToken: accessToken('u1'), session: idleState(0) } }));
    await refresh(core);
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ activity: 'user' });

    jest.advanceTimersByTime(10_000);
    fetchMock.mockResolvedValueOnce(res(200, { data: { accessToken: accessToken('u1'), session: idleState(10_000) } }));
    await refresh(core);
    expect(bodyOf(fetchMock.mock.calls[1])).toEqual({ activity: 'passive' });
  });

  it('input in ANOTHER tab counts', async () => {
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = TestBroadcastChannel;
    stopTracker();
    stopTracker = activityTracker.start();
    const otherTab = new ActivityTracker();
    const stopOther = otherTab.start();
    const core = signedIn();
    jest.advanceTimersByTime(10_000);
    otherTab.record();
    fetchMock.mockResolvedValue(res(200, { data: { accessToken: accessToken('u1'), session: idleState(0) } }));
    await refresh(core);
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ activity: 'user' });
    stopOther();
  });

  it('keeps the idle state from each delivery, in this browser\'s clock', async () => {
    const core = signedIn();
    const seen = jest.fn<AnyFn>();
    core.onSessionIdleChange(seen);
    expect(core.getSessionIdle()).toEqual({
      idleTimeoutMinutes: 15,
      lastActiveAt: Date.now() - MINUTE,
      idleExpiresAt: Date.now() - MINUTE + 15 * MINUTE,
    });
    fetchMock.mockResolvedValue(res(200, { data: { accessToken: accessToken('u1'), session: idleState(0, 10) } }));
    await refresh(core);
    expect(core.getSessionIdle()).toMatchObject({ idleTimeoutMinutes: 10, idleExpiresAt: Date.now() + 10 * MINUTE });
    expect(seen).toHaveBeenCalled();
    core.clearTokens();
    expect(core.getSessionIdle()).toBeNull();
  });

  it('corrects for a skewed client clock using the token\'s iat', () => {
    const core = new ApiCore();
    // The server's clock is 3 minutes behind this browser's: its token says
    // it was minted 3 minutes ago, its deadline is 3 minutes "early".
    const skew = 3 * MINUTE;
    jest.setSystemTime(Date.now() - skew);
    const token = accessToken('u1');
    const session = idleState(0);
    jest.setSystemTime(Date.now() + skew);
    core.setTokens({ accessToken: token, session });
    expect(core.getSessionIdle()!.idleExpiresAt).toBe(Date.now() + 15 * MINUTE);
  });

  it('reportActivity() refreshes as USER at once', async () => {
    const core = signedIn();
    activityTracker.record();
    fetchMock.mockResolvedValue(res(200, { data: { accessToken: accessToken('u1'), session: idleState(0) } }));
    await expect(core.reportActivity()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ activity: 'user' });
  });
});

describe('ApiCore ends an idle session everywhere', () => {
  let fetchMock: jest.Mock<AnyFn>;

  beforeEach(() => {
    fetchMock = jest.fn<AnyFn>();
    global.fetch = fetchMock as unknown as typeof fetch;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = TestBroadcastChannel;
  });

  it('an idle SESSION_EXPIRED names the reason and the timeout, here and in every other tab', async () => {
    const tabA = new ApiCore();
    const tabB = new ApiCore();
    tabA.setTokens({ accessToken: accessToken('u1'), session: idleState(MINUTE) });
    const endedInA = jest.fn<AnyFn>();
    const endedInB = jest.fn<AnyFn>();
    tabA.onSessionExpired(endedInA);
    tabB.onSessionExpired(endedInB);
    fetchMock.mockResolvedValue(res(401, { code: 'SESSION_EXPIRED', details: { reason: 'idle', idleTimeoutMinutes: 15 } }));

    await refresh(tabA);

    expect(tabA.getAccessToken()).toBeNull();
    expect(tabB.getAccessToken()).toBeNull();
    expect(endedInA).toHaveBeenCalledWith('idle', { idleTimeoutMinutes: 15 });
    expect(endedInB).toHaveBeenCalledWith('idle', { idleTimeoutMinutes: 15 });
  });

  it('a max-age SESSION_EXPIRED stays the plain session-expired reason', async () => {
    const core = new ApiCore();
    core.setTokens({ accessToken: accessToken('u1') });
    const ended = jest.fn<AnyFn>();
    core.onSessionExpired(ended);
    fetchMock.mockResolvedValue(res(401, { code: 'SESSION_EXPIRED', details: { reason: 'max-age' } }));
    await refresh(core);
    expect(ended).toHaveBeenCalledWith('session-expired');
  });

  it('an idle sign-out in one tab signs every other tab out with the same reason', () => {
    const tabA = new ApiCore();
    const tabB = new ApiCore();
    const tabC = new ApiCore();
    tabA.setTokens({ accessToken: accessToken('u1'), session: idleState(0) });
    const endedInB = jest.fn<AnyFn>();
    const endedInC = jest.fn<AnyFn>();
    tabB.onSessionExpired(endedInB);
    tabC.onSessionExpired(endedInC);

    tabA.clearTokens({ reason: 'idle', idleTimeoutMinutes: 15 });

    for (const tab of [tabB, tabC]) expect(tab.getAccessToken()).toBeNull();
    expect(endedInB).toHaveBeenCalledWith('idle', { idleTimeoutMinutes: 15 });
    expect(endedInC).toHaveBeenCalledWith('idle', { idleTimeoutMinutes: 15 });
  });

  it('shares the idle state with the other tabs along with the token', () => {
    const tabA = new ApiCore();
    const tabB = new ApiCore();
    tabA.setTokens({ accessToken: accessToken('u1'), session: idleState(2 * MINUTE) });
    expect(tabB.getSessionIdle()).toEqual(tabA.getSessionIdle());
  });
});

/**
 * An impersonating tab keeps the OPERATOR's idle clock running on the server:
 * `reportActivity()` renews the operator's session (the token goes to the
 * sibling tabs, never this one), and every way that renewal can end is handled
 * the way an ordinary refresh's would be.
 */
describe('ApiCore renews the operator session behind an impersonation', () => {
  let fetchMock: jest.Mock<AnyFn>;
  const hadLocks = 'locks' in navigator;

  /** A token for the impersonated user, as `startImpersonation` receives it. */
  function impersonationToken(): string {
    const body = { sub: 'target', organizationId: 'org-t', impersonationReadOnly: true };
    return `h.${Buffer.from(JSON.stringify(body)).toString('base64').replace(/=+$/, '')}.s`;
  }

  /** The operator's tab (impersonating) and a sibling tab on the operator's session. */
  function tabs(): { imp: ApiCore; sibling: ApiCore; impToken: string } {
    const imp = new ApiCore();
    const sibling = new ApiCore();
    imp.setTokens({ accessToken: accessToken('operator'), session: idleState(8 * MINUTE) });
    const impToken = impersonationToken();
    imp.startImpersonation(impToken, 'req-1');
    return { imp, sibling, impToken };
  }

  beforeEach(() => {
    fetchMock = jest.fn<AnyFn>();
    global.fetch = fetchMock as unknown as typeof fetch;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = TestBroadcastChannel;
  });

  afterEach(() => {
    if (!hadLocks) delete (navigator as unknown as Record<string, unknown>).locks;
  });

  it('hands the renewed operator token and idle state to the sibling tabs, and keeps the impersonation token here', async () => {
    const { imp, sibling, impToken } = tabs();
    const renewed = accessToken('operator');
    fetchMock.mockResolvedValue(res(200, { data: { accessToken: renewed, expiresIn: 900, session: idleState(0) } }));

    await expect(imp.reportActivity()).resolves.toBe(true);

    expect(imp.getAccessToken()).toBe(impToken);
    expect(imp.isImpersonating()).toBe(true);
    expect(sibling.getAccessToken()).toBe(renewed);
    // The operator's org, read from the renewed token — not the impersonated org.
    expect(sibling.getOrganizationId()).toBe('org-1');
    // Both tabs now time the restarted idle clock.
    expect(imp.getSessionIdle()!.lastActiveAt).toBe(Date.now());
    expect(sibling.getSessionIdle()).toEqual(imp.getSessionIdle());
  });

  it('a renewal without a session block keeps the idle state this tab already had', async () => {
    const { imp } = tabs();
    const before = imp.getSessionIdle();
    fetchMock.mockResolvedValue(res(200, { data: { accessToken: accessToken('operator'), expiresIn: 900 } }));

    await expect(imp.reportActivity()).resolves.toBe(true);
    expect(imp.getSessionIdle()).toEqual(before);
  });

  it('ignores a session block whose deadline is not a date', async () => {
    const { imp } = tabs();
    const before = imp.getSessionIdle();
    fetchMock.mockResolvedValue(res(200, {
      data: { accessToken: accessToken('operator'), expiresIn: 900, session: { idleTimeoutMinutes: 15, idleExpiresAt: 'soon' } },
    }));

    await expect(imp.reportActivity()).resolves.toBe(true);
    expect(imp.getSessionIdle()).toEqual(before);
  });

  it('sends nothing when this browser holds no session to renew', async () => {
    const { imp } = tabs();
    localStorage.removeItem('pb.session');
    (imp as unknown as { sessionInMemory: boolean }).sessionInMemory = false;

    await expect(imp.reportActivity()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an outage (5xx) reports false and changes nothing: no sign-out, impersonation intact', async () => {
    const { imp, impToken } = tabs();
    const before = imp.getSessionIdle();
    const ended = jest.fn<AnyFn>();
    imp.onSessionExpired(ended);
    fetchMock.mockResolvedValue(res(503));

    await expect(imp.reportActivity()).resolves.toBe(false);
    // One attempt, not the refresh retry ladder: the idle guard asks again.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();
    expect(imp.getAccessToken()).toBe(impToken);
    expect(imp.getSessionIdle()).toEqual(before);
  });

  it('a plain rejection of the cookie signs every tab out, with no reason to show', async () => {
    const { imp, sibling } = tabs();
    const endedHere = jest.fn<AnyFn>();
    const endedThere = jest.fn<AnyFn>();
    imp.onSessionExpired(endedHere);
    sibling.onSessionExpired(endedThere);
    fetchMock.mockResolvedValue(res(401, { code: 'INVALID_REFRESH_TOKEN' }));

    await expect(imp.reportActivity()).resolves.toBe(false);

    expect(imp.getAccessToken()).toBeNull();
    expect(imp.getSessionIdle()).toBeNull();
    expect(endedHere).toHaveBeenCalledWith(undefined);
    expect(endedThere).toHaveBeenCalledWith(undefined);
  });

  it('a renewal that lands after the impersonation ended is dropped', async () => {
    const { imp, sibling } = tabs();
    let answer!: (r: Response) => void;
    fetchMock.mockImplementation((() => new Promise<Response>((r) => { answer = r; })) as AnyFn);

    const done = imp.reportActivity();
    // The tab signs out while the renewal is out.
    imp.clearTokens();
    answer(res(200, { data: { accessToken: accessToken('late'), expiresIn: 900, session: idleState(0) } }));

    await expect(done).resolves.toBe(false);
    expect(imp.getAccessToken()).toBeNull();
    expect(imp.getSessionIdle()).toBeNull();
    // The sign-out reached the sibling; the late token did not.
    expect(sibling.getAccessToken()).toBeNull();
  });

  it('renews under the cross-tab lock, and gives up without a request when the lock is never granted', async () => {
    const { imp } = tabs();
    const names: string[] = [];
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (name: string, opts: { signal?: AbortSignal }) => {
          names.push(name);
          return new Promise((_, reject) => {
            opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        },
      },
    });

    const done = imp.reportActivity();
    await jest.advanceTimersByTimeAsync(10 * MINUTE);

    await expect(done).resolves.toBe(false);
    expect(names).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
