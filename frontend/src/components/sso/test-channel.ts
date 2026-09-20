// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The popup ↔ settings-page hand-off for an SSO TEST CONNECTION.
 *
 * Same shape as the step-up re-auth hand-off (src/lib/step-up-reauth.ts): the
 * IdP round trip happens in a popup, and the page that holds the admin's
 * session collects the result. The popup lands on the ORDINARY sign-in pages —
 * `/auth/sso/[orgId]/callback` (OIDC, with `code` + the `ssotest.` state) or
 * `/auth/sso/[orgId]/saml?test=<state>` (SAML, whose ACS already verified the
 * assertion server-side) — which spot the marker and hand it back here instead
 * of signing anyone in. Nothing but the state (and, for OIDC, the one-time
 * code) crosses, and only to our own origin.
 */

/** Prefix the platform puts on every test `state` / `RelayState`. */
export const SSO_TEST_STATE_PREFIX = 'ssotest.';

/** Same-origin channel the landing pages answer on. */
export const SSO_TEST_CHANNEL = 'pb-sso-test';

export interface SsoTestPopupResult {
  type: typeof SSO_TEST_CHANNEL;
  state: string;
  code?: string;
  error?: string;
}

/** Whether a `state` belongs to a test connection rather than a sign-in. */
export function isSsoTestState(state: string | undefined | null): state is string {
  return typeof state === 'string' && state.startsWith(SSO_TEST_STATE_PREFIX);
}

/** Publish the popup's result back to the settings page (channel + opener). */
export function publishSsoTestResult(result: SsoTestPopupResult): void {
  try {
    if (typeof BroadcastChannel === 'function') {
      const channel = new BroadcastChannel(SSO_TEST_CHANNEL);
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

/** How long to wait for the popup (the server-side state expires anyway). */
export const SSO_TEST_TIMEOUT_MS = 10 * 60_000;

/** Wait for the popup's result for `state`, from either transport. */
export function awaitSsoTestResult(state: string, signal: AbortSignal, timeoutMs = SSO_TEST_TIMEOUT_MS): Promise<SsoTestPopupResult> {
  return new Promise<SsoTestPopupResult>((resolve, reject) => {
    let channel: BroadcastChannel | null = null;
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      signal.removeEventListener('abort', onAbort);
      channel?.close();
    };
    const accept = (data: unknown) => {
      const result = data as SsoTestPopupResult | null;
      if (!result || result.type !== SSO_TEST_CHANNEL || result.state !== state) return;
      cleanup();
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      // Only our own origin: the IdP's page must not be able to answer for us.
      if (event.origin !== window.location.origin) return;
      accept(event.data);
    };
    const onAbort = () => { cleanup(); reject(new Error('Test cancelled')); };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the identity provider window. Run the test again.'));
    }, timeoutMs);

    window.addEventListener('message', onMessage);
    signal.addEventListener('abort', onAbort);
    try {
      if (typeof BroadcastChannel === 'function') {
        channel = new BroadcastChannel(SSO_TEST_CHANNEL);
        channel.onmessage = (event) => accept(event.data);
      }
    } catch {
      /* channel unavailable — the message listener covers it */
    }
  });
}
