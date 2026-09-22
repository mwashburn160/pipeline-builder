// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PKCE (RFC 7636) for every authorization-code flow the platform starts:
 * per-org SSO, social sign-in, and the step-up provider re-auth that shares
 * their helpers.
 *
 * WHAT IT BUYS US: the `state` parameter proves the callback belongs to a flow
 * WE started, but it does not prove the party redeeming the authorization CODE
 * is the same party that started it. An authorization code that leaks — through
 * a referrer header, a redirect-URI mix-up, browser history, or a malicious app
 * registered on the same custom scheme — can otherwise be redeemed by whoever
 * holds it. PKCE binds the code to a secret that never leaves this server: the
 * authorization request carries only the SHA-256 of the verifier, and the token
 * exchange must present the verifier itself.
 *
 * S256 ONLY. The `plain` method puts the verifier in the authorization request,
 * where anyone who can see the code can see it too — it is no protection at all
 * against the attack above, so we never negotiate down to it. A provider that
 * advertises its supported methods and omits `S256` simply gets no PKCE.
 *
 * Node's `crypto` covers both halves; no dependency is needed.
 */

import crypto from 'crypto';

/** The only challenge method we ever send (see the module note on `plain`). */
export const PKCE_METHOD_S256 = 'S256';

/**
 * A fresh `code_verifier`: 32 random bytes as unpadded base64url = 43
 * characters, at the low end of RFC 7636 §4.1's 43-128 range and drawn from its
 * unreserved alphabet, so it needs no further encoding in a form body.
 */
export function createCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** The `code_challenge` for a verifier: unpadded base64url of its SHA-256. */
export function codeChallengeFor(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** The authorization-request parameters for a verifier. Spread into the query. */
export function pkceAuthorizeParams(verifier: string): Record<string, string> {
  return { code_challenge: codeChallengeFor(verifier), code_challenge_method: PKCE_METHOD_S256 };
}
