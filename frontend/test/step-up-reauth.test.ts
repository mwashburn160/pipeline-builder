// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The step-up provider re-auth round trip (src/lib/step-up-reauth).
 *
 * Contract: the popup opens on the click (before any await), the server-minted
 * `state` is what the returning message must match, a message from any other
 * origin is ignored, and only this window exchanges the code for the step-up
 * token. Cancelling aborts the wait.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { isReauthState, publishReauthResult, runProviderReauth } from '../src/lib/step-up-reauth';

const startStepUpReauth = jest.fn<AnyFn>();
const completeStepUpReauth = jest.fn<AnyFn>();
jest.mock('../src/lib/api', () => {
  const api = {
    startStepUpReauth: (...a: unknown[]) => startStepUpReauth(...a),
    completeStepUpReauth: (...a: unknown[]) => completeStepUpReauth(...a),
  };
  return { __esModule: true, default: api, api };
});

const ORIGIN = window.location.origin;

/** A popup stub that plays the callback page's part when it is navigated. */
function fakePopup(reply: (url: string) => unknown | null) {
  const close = jest.fn<AnyFn>();
  const popup = {
    close,
    location: {
      set href(url: string) {
        const message = reply(url);
        if (message !== null) {
          setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: message, origin: ORIGIN })), 0);
        }
      },
    },
  };
  return { popup, close };
}

let openSpy: jest.Spied<typeof window.open>;
afterEach(() => {
  openSpy?.mockRestore();
  jest.clearAllMocks();
});

const reauthResult = (state: string, extra: Record<string, unknown>) => ({ type: 'pb-step-up-reauth', state, ...extra });

describe('isReauthState', () => {
  it('recognizes only a server-minted re-auth state', () => {
    expect(isReauthState('reauth.abc')).toBe(true);
    expect(isReauthState('abc')).toBe(false);
    expect(isReauthState(undefined)).toBe(false);
  });
});

describe('publishReauthResult', () => {
  it('posts the result to the opener at this origin only', () => {
    const postMessage = jest.fn<AnyFn>();
    Object.defineProperty(window, 'opener', { value: { postMessage }, configurable: true });
    publishReauthResult({ type: 'pb-step-up-reauth', state: 'reauth.1', code: 'c1' });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ state: 'reauth.1', code: 'c1' }), ORIGIN);
    Object.defineProperty(window, 'opener', { value: null, configurable: true });
  });
});

describe('runProviderReauth', () => {
  it('exchanges the returned code for a step-up token', async () => {
    startStepUpReauth.mockResolvedValue({ success: true, data: { url: 'https://provider.test/auth', state: 'reauth.s1' } });
    completeStepUpReauth.mockResolvedValue({ success: true, data: { stepUpToken: 'stepup.tok' } });
    const { popup, close } = fakePopup(() => reauthResult('reauth.s1', { code: 'code-1' }));
    openSpy = jest.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

    const token = await runProviderReauth({ type: 'oauth', provider: 'google' }, new AbortController().signal);

    expect(token).toBe('stepup.tok');
    expect(startStepUpReauth).toHaveBeenCalledWith({ type: 'oauth', provider: 'google' });
    expect(completeStepUpReauth).toHaveBeenCalledWith({ code: 'code-1', state: 'reauth.s1' });
    expect(close).toHaveBeenCalled();
  });

  it('refuses when the popup was blocked', async () => {
    openSpy = jest.spyOn(window, 'open').mockReturnValue(null);
    await expect(runProviderReauth({ type: 'oauth', provider: 'google' }, new AbortController().signal))
      .rejects.toThrow(/Allow pop-ups/);
    expect(startStepUpReauth).not.toHaveBeenCalled();
  });

  it('surfaces a provider denial reported by the callback page', async () => {
    startStepUpReauth.mockResolvedValue({ success: true, data: { url: 'https://provider.test/auth', state: 'reauth.s2' } });
    const { popup } = fakePopup(() => reauthResult('reauth.s2', { error: 'Sign-in was cancelled' }));
    openSpy = jest.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

    await expect(runProviderReauth({ type: 'sso', provider: 'generic-oidc', orgId: 'org1' }, new AbortController().signal))
      .rejects.toThrow('Sign-in was cancelled');
    expect(completeStepUpReauth).not.toHaveBeenCalled();
  });

  it('ignores a message from another origin or another flow', async () => {
    startStepUpReauth.mockResolvedValue({ success: true, data: { url: 'https://provider.test/auth', state: 'reauth.s3' } });
    completeStepUpReauth.mockResolvedValue({ success: true, data: { stepUpToken: 'right.tok' } });
    const { popup } = fakePopup(() => {
      // A hostile origin, then a message for a different flow, then the real one.
      setTimeout(() => {
        window.dispatchEvent(new MessageEvent('message', { data: reauthResult('reauth.s3', { code: 'evil' }), origin: 'https://evil.test' }));
        window.dispatchEvent(new MessageEvent('message', { data: reauthResult('reauth.other', { code: 'other' }), origin: ORIGIN }));
      }, 0);
      return reauthResult('reauth.s3', { code: 'good' });
    });
    openSpy = jest.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

    expect(await runProviderReauth({ type: 'oauth', provider: 'google' }, new AbortController().signal)).toBe('right.tok');
    expect(completeStepUpReauth).toHaveBeenCalledWith({ code: 'good', state: 'reauth.s3' });
  });

  it('rejects when the wait is aborted (dialog cancelled)', async () => {
    startStepUpReauth.mockResolvedValue({ success: true, data: { url: 'https://provider.test/auth', state: 'reauth.s4' } });
    const controller = new AbortController();
    const { popup } = fakePopup(() => { setTimeout(() => controller.abort(), 0); return null; });
    openSpy = jest.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

    await expect(runProviderReauth({ type: 'oauth', provider: 'google' }, controller.signal))
      .rejects.toThrow(/cancelled/i);
    expect(completeStepUpReauth).not.toHaveBeenCalled();
  });

  // The dialog can be closed while POST /auth/step-up/reauth is still out. The
  // signal has then ALREADY fired by the time the wait subscribes to it, so the
  // wait must check it up front — an 'abort' listener added afterwards never
  // runs, and the popup sat on the provider's page for the 5-minute timeout.
  it('rejects at once (and closes the popup) when cancelled before the start request returned', async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      startStepUpReauth.mockImplementation(async () => {
        controller.abort();
        return { success: true, data: { url: 'https://provider.test/auth', state: 'reauth.s5' } };
      });
      const navigated = jest.fn<AnyFn>();
      const { popup, close } = fakePopup((url) => { navigated(url); return null; });
      openSpy = jest.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

      let outcome: unknown = 'pending';
      const run = runProviderReauth({ type: 'oauth', provider: 'google' }, controller.signal)
        .then(() => { outcome = 'resolved'; }, (e: Error) => { outcome = e.message; });
      // Well short of the 5-minute timeout.
      await jest.advanceTimersByTimeAsync(1_000);
      expect(outcome).toMatch(/cancelled/i);
      expect(navigated).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      await run;
    } finally {
      jest.useRealTimers();
    }
  });
});
