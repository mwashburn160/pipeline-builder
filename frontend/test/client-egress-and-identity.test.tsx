// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The three client-side paths that carry identity or secrets and had no test:
 *
 *  - `error-reporter` — the ONLY place the app sends text off-box (via the
 *    same-origin relay), and it was shipping `window.location.href` verbatim
 *    from pages whose query string holds a live invite token or OAuth
 *    authorization code.
 *  - `usePlugins` cache — module-level state that outlives React, so it kept
 *    serving the previous tenant's plugins after an org switch.
 *  - the OAuth intent hand-off — where a lost intent silently turned an
 *    invitation into a brand-new self-serve org.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
// Must be a top-level import: @testing-library/react registers its own
// beforeAll/afterEach, and jest rejects hooks defined inside a test body.
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePlugins } from '../src/hooks/usePlugins';
import { clearQueryCache } from '../src/lib/query-cache';

const listPlugins = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { listPlugins: (...a: unknown[]) => listPlugins(...a) },
}));

describe('error-reporter egress', () => {
  let sent: Array<{ url: string; init: RequestInit }>;
  let relayState: 'on' | 'off';
  let relayStateReads: number;
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  beforeEach(() => {
    jest.resetModules();
    sent = [];
    relayState = 'on';
    relayStateReads = 0;
    // The reporter posts to the same-origin relay; capture each request and
    // answer with the relay's on/off header.
    global.fetch = jest.fn<AnyFn>(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      // jsdom has no `Response`; the reporter only reads this one header.
      return {
        status: 204,
        headers: {
          get: (h: string) => {
            if (h !== 'X-Error-Reporting') return null;
            relayStateReads += 1;
            return relayState;
          },
        },
      };
    }) as unknown as typeof fetch;
  });

  /** Report one error from `href` and return the parsed payload. */
  async function report(href: string, error = new Error('boom')) {
    window.history.replaceState({}, '', new URL(href).pathname + new URL(href).search);
    const { reportClientError } = await import('../src/lib/error-reporter');
    reportClientError(error, { source: 'react', url: href });
    return JSON.parse(String(sent[0].init.body));
  }

  it('posts to the same-origin relay (CSP connect-src stays self)', async () => {
    await report('http://localhost/dashboard');
    expect(sent[0].url).toBe('/client-errors');
    expect(sent[0].init).toEqual(expect.objectContaining({ method: 'POST', keepalive: true, credentials: 'omit' }));
  });

  it('REGRESSION: strips the query string, which carries the invite token', async () => {
    const payload = await report('http://localhost/invite/accept?token=SECRET-INVITE-TOKEN');
    expect(payload.url).toBe('http://localhost/invite/accept');
    expect(String(sent[0].init.body)).not.toContain('SECRET-INVITE-TOKEN');
  });

  it('REGRESSION: strips the OAuth authorization code and state', async () => {
    const payload = await report('http://localhost/auth/callback/google?code=AUTH-CODE&state=ST8');
    expect(payload.url).toBe('http://localhost/auth/callback/google');
    expect(String(sent[0].init.body)).not.toContain('AUTH-CODE');
    expect(String(sent[0].init.body)).not.toContain('ST8');
  });

  it('strips the email-verification token', async () => {
    const payload = await report('http://localhost/auth/verify-email?token=VERIFY-TOK');
    expect(payload.url).toBe('http://localhost/auth/verify-email');
    expect(String(sent[0].init.body)).not.toContain('VERIFY-TOK');
  });

  it('keeps the path, so the report is still actionable', async () => {
    const payload = await report('http://localhost/dashboard/pipelines/abc?tab=runs');
    expect(payload.url).toBe('http://localhost/dashboard/pipelines/abc');
  });

  it('redacts an AWS account id quoted into the error message', async () => {
    const payload = await report(
      'http://localhost/dashboard',
      new Error('AccessDenied for arn:aws:iam::123456789012:role/thing'),
    );
    expect(payload.message).not.toContain('123456789012');
  });

  it('stops sending once the relay reports no collector is configured', async () => {
    relayState = 'off';
    const { reportClientError } = await import('../src/lib/error-reporter');
    reportClientError(new Error('first'), { source: 'react' });
    expect(sent).toHaveLength(1);
    // Wait until the reporter has read the relay's answer (which latches "off").
    await waitFor(() => expect(relayStateReads).toBe(1));
    reportClientError(new Error('second'), { source: 'react' });
    expect(sent).toHaveLength(1);
  });
});

describe('usePlugins cache invalidation', () => {
  it('REGRESSION: an in-flight fetch does NOT refill the cache after a clear', async () => {
    // The identity-boundary reset (`clearQueryCache`, run on org switch, logout
    // and session expiry) must also discard a request already in flight, or its
    // answer lands the PREVIOUS tenant's plugins in the cache for the full TTL.
    clearQueryCache(); // start from a known-empty cache
    let release!: (v: unknown) => void;
    const inFlight = new Promise((r) => { release = r; });
    listPlugins.mockReturnValueOnce(inFlight as Promise<unknown>);

    const first = renderHook(() => usePlugins(true));
    await waitFor(() => expect(listPlugins).toHaveBeenCalledTimes(1));

    // Identity changes while tenant A's request is still outstanding: the
    // mounted reader re-reads under the new identity.
    listPlugins.mockResolvedValueOnce({ data: { plugins: [] } });
    act(() => { clearQueryCache(); });
    await act(async () => {
      release({ data: { plugins: [{ id: 'tenant-a-plugin', name: 'A' }] } });
      await inFlight;
    });
    await waitFor(() => expect(listPlugins).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    expect(first.result.current.plugins).toEqual([]);

    // A fresh consumer is served the new identity's answer, never tenant A's.
    const second = renderHook(() => usePlugins(true));
    await waitFor(() => expect(second.result.current.isLoading).toBe(false));
    expect(second.result.current.plugins).toEqual([]);
  });
});

describe('OAuth intent hand-off', () => {
  beforeEach(() => {
    jest.resetModules();
    sessionStorage.clear();
  });

  it('stores and takes back a login intent', async () => {
    const { storeOAuthIntent, takeOAuthIntent, OAUTH_INTENT_KEY } =
      await import('../src/lib/oauth-intent');

    storeOAuthIntent({ state: 's1', kind: 'login', returnUrl: '/dashboard' });
    expect(sessionStorage.getItem(OAUTH_INTENT_KEY)).toBeTruthy();

    const intent = takeOAuthIntent();
    expect(intent).toEqual({ state: 's1', kind: 'login', returnUrl: '/dashboard' });
    // Single-use: taking it clears it.
    expect(sessionStorage.getItem(OAUTH_INTENT_KEY)).toBeNull();
  });

  it('REGRESSION: an intent THROWS when storage is blocked (invite AND login)', async () => {
    // Swallowing this is what let an invite-accept redirect anyway, lose the
    // token, and auto-provision a brand-new org for the invitee — and a login
    // that recorded no intent could never complete (the callback refuses an
    // arrival with none: login CSRF).
    const { storeOAuthIntent } = await import('../src/lib/oauth-intent');
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    try {
      expect(() =>
        storeOAuthIntent({ state: 's1', kind: 'invite', inviteToken: 't', provider: 'google' }),
      ).toThrow();
      expect(() =>
        storeOAuthIntent({ state: 's1', kind: 'login', returnUrl: '/dashboard' }),
      ).toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('returns null for a malformed stored intent rather than throwing', async () => {
    const { takeOAuthIntent, OAUTH_INTENT_KEY } = await import('../src/lib/oauth-intent');
    sessionStorage.setItem(OAUTH_INTENT_KEY, '{not json');
    expect(takeOAuthIntent()).toBeNull();
  });
});
