// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The three client-side paths that carry identity or secrets and had no test:
 *
 *  - `error-reporter` — the ONLY place the app sends text off-box, and it was
 *    shipping `window.location.href` verbatim from pages whose query string
 *    holds a live invite token or OAuth authorization code.
 *  - `usePlugins` cache — module-level state that outlives React, so it kept
 *    serving the previous tenant's plugins after an org switch.
 *  - the OAuth intent hand-off — where a lost intent silently turned an
 *    invitation into a brand-new self-serve org.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
// Must be a top-level import: @testing-library/react registers its own
// beforeAll/afterEach, and jest rejects hooks defined inside a test body.
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePlugins, clearPluginCache } from '../src/hooks/usePlugins';

const listPlugins = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { listPlugins: (...a: unknown[]) => listPlugins(...a) },
}));

describe('error-reporter egress', () => {
  const ENDPOINT = 'https://collector.test/report';
  let sent: string[];

  beforeEach(() => {
    jest.resetModules();
    sent = [];
    process.env.NEXT_PUBLIC_ERROR_REPORT_URL = ENDPOINT;
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      // Blob.text() is async; capture synchronously via the constructor arg instead.
      value: jest.fn((_url: string, blob: Blob) => {
        sent.push((blob as unknown as { __payload: string }).__payload);
        return true;
      }),
    });
    // jsdom's Blob doesn't expose its parts; stash them for the assertion.
    const RealBlob = global.Blob;
    global.Blob = class extends RealBlob {
      __payload: string;
      constructor(parts: BlobPart[], opts?: BlobPropertyBag) {
        super(parts, opts);
        this.__payload = String(parts[0]);
      }
    } as unknown as typeof Blob;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_ERROR_REPORT_URL;
  });

  /** Report one error from `href` and return the parsed payload. */
  async function report(href: string, error = new Error('boom')) {
    window.history.replaceState({}, '', new URL(href).pathname + new URL(href).search);
    const { reportClientError } = await import('../src/lib/error-reporter');
    reportClientError(error, { source: 'react', url: href });
    return JSON.parse(sent[0]);
  }

  it('REGRESSION: strips the query string, which carries the invite token', async () => {
    const payload = await report('http://localhost/invite/accept?token=SECRET-INVITE-TOKEN');
    expect(payload.url).toBe('http://localhost/invite/accept');
    expect(sent[0]).not.toContain('SECRET-INVITE-TOKEN');
  });

  it('REGRESSION: strips the OAuth authorization code and state', async () => {
    const payload = await report('http://localhost/auth/callback/google?code=AUTH-CODE&state=ST8');
    expect(payload.url).toBe('http://localhost/auth/callback/google');
    expect(sent[0]).not.toContain('AUTH-CODE');
    expect(sent[0]).not.toContain('ST8');
  });

  it('strips the email-verification token', async () => {
    const payload = await report('http://localhost/auth/verify-email?token=VERIFY-TOK');
    expect(payload.url).toBe('http://localhost/auth/verify-email');
    expect(sent[0]).not.toContain('VERIFY-TOK');
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

  it('is a no-op when no collector is configured', async () => {
    delete process.env.NEXT_PUBLIC_ERROR_REPORT_URL;
    jest.resetModules();
    const { reportClientError } = await import('../src/lib/error-reporter');
    reportClientError(new Error('boom'), { source: 'react' });
    expect(sent).toHaveLength(0);
  });
});

describe('usePlugins cache invalidation', () => {
  it('REGRESSION: an in-flight fetch does NOT refill the cache after a clear', async () => {
    // `clearPluginCache` runs on org switch, logout and session expiry, but it
    // could not cancel a request already in flight — whose closure then wrote
    // the PREVIOUS tenant's plugins back into the cache, where they were served
    // for the full TTL.
    clearPluginCache(); // start from a known-empty cache
    let release!: (v: unknown) => void;
    const inFlight = new Promise((r) => { release = r; });
    listPlugins.mockReturnValueOnce(inFlight as Promise<unknown>);

    const first = renderHook(() => usePlugins(true));
    await waitFor(() => expect(listPlugins).toHaveBeenCalledTimes(1));

    // Identity changes while tenant A's request is still outstanding.
    act(() => { clearPluginCache(); });
    await act(async () => {
      release({ data: { plugins: [{ id: 'tenant-a-plugin', name: 'A' }] } });
      await inFlight;
    });
    first.unmount();

    // A fresh consumer must NOT be served tenant A's list from cache — the
    // stale write must have been discarded, forcing a new request.
    listPlugins.mockResolvedValueOnce({ data: { plugins: [] } });
    renderHook(() => usePlugins(true));
    await waitFor(() => expect(listPlugins).toHaveBeenCalledTimes(2));
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

    storeOAuthIntent({ state: 's1', kind: 'login', returnUrl: '/dashboard' }, false);
    expect(sessionStorage.getItem(OAUTH_INTENT_KEY)).toBeTruthy();

    const intent = takeOAuthIntent();
    expect(intent).toEqual({ state: 's1', kind: 'login', returnUrl: '/dashboard' });
    // Single-use: taking it clears it.
    expect(sessionStorage.getItem(OAUTH_INTENT_KEY)).toBeNull();
  });

  it('REGRESSION: a required (invite) intent THROWS when storage is blocked', async () => {
    // Swallowing this is what let an invite-accept redirect anyway, lose the
    // token, and auto-provision a brand-new org for the invitee.
    const { storeOAuthIntent } = await import('../src/lib/oauth-intent');
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    try {
      expect(() =>
        storeOAuthIntent({ state: 's1', kind: 'invite', inviteToken: 't', provider: 'google' }, true),
      ).toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('a plain login still proceeds when storage is blocked (backend validates state)', async () => {
    const { storeOAuthIntent } = await import('../src/lib/oauth-intent');
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    try {
      expect(() =>
        storeOAuthIntent({ state: 's1', kind: 'login', returnUrl: '/dashboard' }, false),
      ).not.toThrow();
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
