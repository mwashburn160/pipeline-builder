// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The single-sign-on redirect hand-off: the `state` of the SSO sign-in THIS tab
 * started, kept in `sessionStorage` across the trip to the identity provider.
 *
 * The SSO landing pages refuse an arrival with no matching intent — a code (or
 * SAML handoff) planted in this browser by someone else's sign-in (login CSRF)
 * has none. The platform enforces the same rule server-side with an HttpOnly
 * binding cookie; this is the browser's half, so such an arrival is refused
 * before anything is sent.
 */

const SSO_INTENT_KEY = 'pb_sso_intent';

/** Record the state of an SSO sign-in about to leave for the IdP. Throws when
 *  storage is unavailable — the landing page could never complete the flow. */
export function storeSsoIntent(state: string): void {
  sessionStorage.setItem(SSO_INTENT_KEY, state);
}

/** Read and clear the pending SSO intent (single-use). Null when absent. */
export function takeSsoIntent(): string | null {
  try {
    const state = sessionStorage.getItem(SSO_INTENT_KEY);
    sessionStorage.removeItem(SSO_INTENT_KEY);
    return state || null;
  } catch {
    return null;
  }
}
