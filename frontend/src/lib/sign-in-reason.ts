// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Why the person is on the sign-in page, carried as `/?reason=<reason>`.
 *
 *  - `session-expired`  `/auth/refresh` answered 401 `SESSION_EXPIRED`: the
 *    session outlived its policy (maximum age / idle timeout). Not a fault —
 *    just over.
 *  - `org-reauth`       `switch-org` answered 403 `SESSION_POLICY_REAUTH_REQUIRED`:
 *    the session is valid where it was, but older (or idler) than the
 *    destination org's session policy allows; the person chose to sign in again.
 *
 * A generic refresh rejection (revoked, signed out elsewhere) still lands on
 * `/?expired=1` with the older wording.
 */
export type SignInReason = 'session-expired' | 'org-reauth';

/** `switch-org`'s 403 code: entering this org needs a fresh sign-in. */
export const SESSION_POLICY_REAUTH_REQUIRED = 'SESSION_POLICY_REAUTH_REQUIRED';

export const SIGN_IN_REASON_MESSAGES: Record<SignInReason, string> = {
  'session-expired': 'Your session expired. Sign in again.',
  'org-reauth': 'That organization requires a recent sign-in. Sign in again, then switch to it.',
};

/** The sign-in page for `reason`. */
export function signInHref(reason: SignInReason): string {
  return `/?reason=${encodeURIComponent(reason)}`;
}

/** The `reason` query value, when it is one this app sets (anything else is ignored). */
export function parseSignInReason(value: unknown): SignInReason | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SIGN_IN_REASON_MESSAGES, v)
    ? (v as SignInReason)
    : null;
}

/** True when `switch-org` refused because the destination's session policy needs a fresh sign-in. */
export function isSessionPolicyReauth(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === SESSION_POLICY_REAUTH_REQUIRED;
}
