// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The OAuth redirect hand-off.
 *
 * Starting an OAuth flow means leaving the app entirely, so what the user was
 * trying to DO has to survive the round trip. It rides in `sessionStorage`
 * keyed by the provider's CSRF `state`, and `/auth/callback/[provider]` reads
 * it back to decide between "log this person in" and "accept this invitation".
 *
 * Centralized because the key was re-declared in four files (and written as a
 * bare literal in a fifth) with `startOAuth` copy-pasted byte-for-byte between
 * two of them — renaming the key in three places would have silently broken the
 * invite flow while leaving login working.
 */

import { api } from './api';
import { DEFAULT_POST_SIGN_IN_PATH, sanitizeReturnPath } from './return-to';

/** sessionStorage key holding the pending {@link OAuthIntent}. */
export const OAUTH_INTENT_KEY = 'pb_oauth_intent';

/** What the user was doing when they left for the provider. */
export type OAuthIntent =
  | { state: string; kind: 'login'; returnUrl: string }
  | { state: string; kind: 'invite'; inviteToken: string; provider: string };

/** Read and clear the pending intent. Returns null when absent/unparseable. */
export function takeOAuthIntent(): OAuthIntent | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(OAUTH_INTENT_KEY);
    sessionStorage.removeItem(OAUTH_INTENT_KEY);
  } catch {
    return null; // storage unavailable
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OAuthIntent;
  } catch {
    return null;
  }
}

/**
 * Persist the intent for the callback to pick up.
 *
 * @param required when true, a storage failure THROWS instead of being
 *   swallowed. Use it whenever the intent carries the only copy of something —
 *   an invite token — because continuing without it silently changes what the
 *   flow does (an invite-accept degrades into creating a brand-new org).
 *   Plain logins pass `false`: the backend still validates `state`, so a
 *   storage-blocked browser can still sign in.
 */
export function storeOAuthIntent(intent: OAuthIntent, required: boolean): void {
  try {
    sessionStorage.setItem(OAUTH_INTENT_KEY, JSON.stringify(intent));
  } catch (err) {
    if (required) throw err;
    /* storage unavailable — backend still validates state */
  }
}

/**
 * Begin a login/sign-up OAuth flow: fetch the provider URL + CSRF state, stash
 * a `login` intent under that state, then hand the browser to the provider.
 *
 * Returns nothing and never resolves in the success case — the page is
 * navigating away. Throws when the provider URL can't be obtained, so callers
 * can surface it and re-enable their button.
 */
export async function startOAuthLogin(provider: string, returnUrl: string = DEFAULT_POST_SIGN_IN_PATH): Promise<void> {
  const res = await api.getOAuthUrl(provider);
  const url = res.data?.url;
  const state = res.data?.state;
  if (!url || !state) throw new Error('Could not start sign-in with this provider');
  // Sanitized on the way in as well as out (the callback re-checks it).
  storeOAuthIntent({ state, kind: 'login', returnUrl: sanitizeReturnPath(returnUrl) ?? DEFAULT_POST_SIGN_IN_PATH }, false);
  window.location.href = url;
}
