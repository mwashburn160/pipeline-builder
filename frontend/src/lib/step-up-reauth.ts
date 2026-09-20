// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Step-up by signing in again with the user's own provider.
 *
 * The flow has to leave the app (the provider's page) and come back, but the
 * action being gated lives in the page that opened the step-up modal — so the
 * round trip happens in a POPUP and the main window keeps its state:
 *
 *   1. open the popup synchronously on the click (else pop-up blockers win);
 *   2. POST /auth/step-up/reauth for the authorize URL + the server-minted
 *      `state` (prefixed `reauth.`, bound to the signed-in user, single-use);
 *   3. point the popup at the provider;
 *   4. the provider redirects to the ORDINARY sign-in callback page, which sees
 *      the `reauth.` prefix and hands `code` + `state` back here (a same-origin
 *      BroadcastChannel, plus `postMessage` to the opener as a fallback — a
 *      provider's COOP header can sever `window.opener`);
 *   5. this window — the one holding the session — exchanges them for the
 *      step-up token.
 *
 * The code never travels anywhere but same-origin: the popup posts it back and
 * this window sends it to the platform over the normal authenticated client.
 */

import { api } from './api';
import type { ReauthProvider } from '@/types';

/** Prefix the backend puts on every re-auth `state`. */
const REAUTH_STATE_PREFIX = 'reauth.';

/** Same-origin channel the callback page answers on. */
const REAUTH_CHANNEL = 'pb-step-up-reauth';

/** What the callback page sends back. */
export interface ReauthResult {
  type: typeof REAUTH_CHANNEL;
  state: string;
  code?: string;
  error?: string;
}

/** Whether a CSRF `state` belongs to a step-up re-auth rather than a sign-in. */
export function isReauthState(state: string | undefined): boolean {
  return typeof state === 'string' && state.startsWith(REAUTH_STATE_PREFIX);
}

/** Publish the provider's result from the callback page back to the app window. */
export function publishReauthResult(result: ReauthResult): void {
  try {
    if (typeof BroadcastChannel === 'function') {
      const channel = new BroadcastChannel(REAUTH_CHANNEL);
      channel.postMessage(result);
      channel.close();
    }
  } catch {
    /* channel unavailable — the opener postMessage below still covers it */
  }
  try {
    window.opener?.postMessage(result, window.location.origin);
  } catch {
    /* opener gone (COOP) — the channel above covers it */
  }
}

/** How long to wait for the popup before giving up (the state expires anyway). */
const REAUTH_TIMEOUT_MS = 5 * 60_000;

/** Wait for the callback page's message for `state`, from either transport. */
function awaitResult(state: string, signal: AbortSignal): Promise<ReauthResult> {
  return new Promise<ReauthResult>((resolve, reject) => {
    let channel: BroadcastChannel | null = null;
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      signal.removeEventListener('abort', onAbort);
      channel?.close();
    };
    const accept = (data: unknown) => {
      const result = data as ReauthResult | null;
      if (!result || result.type !== REAUTH_CHANNEL || result.state !== state) return;
      cleanup();
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      // Only ever trust our own origin — the provider's page must not be able
      // to hand us a code for someone else's flow.
      if (event.origin !== window.location.origin) return;
      accept(event.data);
    };
    const onAbort = () => { cleanup(); reject(new Error('Confirmation cancelled')); };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the sign-in window. Please try again.'));
    }, REAUTH_TIMEOUT_MS);

    window.addEventListener('message', onMessage);
    signal.addEventListener('abort', onAbort);
    try {
      if (typeof BroadcastChannel === 'function') {
        channel = new BroadcastChannel(REAUTH_CHANNEL);
        channel.onmessage = (event) => accept(event.data);
      }
    } catch {
      /* channel unavailable — the message listener covers it */
    }
  });
}

/**
 * Run a full provider re-auth and return the step-up token.
 *
 * Throws with a user-facing message when the popup is blocked, the user closes
 * it (via `signal`), the provider denies, or the server refuses the identity.
 */
export async function runProviderReauth(option: ReauthProvider, signal: AbortSignal): Promise<string> {
  // Opened first, on the click, or the browser treats it as an unsolicited popup.
  const popup = window.open('', 'pb-step-up-reauth', 'width=520,height=680');
  if (!popup) throw new Error('Allow pop-ups for this site to confirm with your sign-in provider.');

  try {
    const started = await api.startStepUpReauth(option);
    const url = started.data?.url;
    const state = started.data?.state;
    if (!url || !state) throw new Error(started.message || 'Could not start the sign-in confirmation');

    const waiting = awaitResult(state, signal);
    popup.location.href = url;

    const result = await waiting;
    if (result.error) throw new Error(result.error);
    if (!result.code) throw new Error('The sign-in provider returned no authorization code.');

    const done = await api.completeStepUpReauth({ code: result.code, state });
    const token = done.data?.stepUpToken;
    if (!done.success || !token) throw new Error(done.message || 'Could not confirm your identity');
    return token;
  } finally {
    try { popup.close(); } catch { /* already closed by the callback page */ }
  }
}
