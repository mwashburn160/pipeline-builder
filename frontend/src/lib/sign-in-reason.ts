// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Why the person is on the sign-in page, carried as `/?reason=<reason>`.
 *
 *  - `session-expired`  `/auth/refresh` answered 401 `SESSION_EXPIRED`: the
 *    session outlived its policy (maximum age / idle timeout). Not a fault —
 *    just over.
 *  - `idle`             signed out for inactivity: no real input for the
 *    session's idle timeout — the warning ran out in some tab, or the server
 *    refused a refresh for it. Carries `&minutes=N` for the message.
 *  - `org-reauth`       `switch-org` answered 403 `SESSION_POLICY_REAUTH_REQUIRED`:
 *    the session is valid where it was, but older (or idler) than the
 *    destination org's session policy allows; the person chose to sign in again.
 *
 * A generic refresh rejection (revoked, signed out elsewhere) still lands on
 * `/?expired=1` with the older wording.
 */
export type SignInReason = 'session-expired' | 'idle' | 'org-reauth';

/** `switch-org`'s 403 code: entering this org needs a fresh sign-in. */
export const SESSION_POLICY_REAUTH_REQUIRED = 'SESSION_POLICY_REAUTH_REQUIRED';

export const SIGN_IN_REASON_MESSAGES: Record<SignInReason, string> = {
  'session-expired': 'Your session expired. Sign in again.',
  idle: 'Signed out after a period of inactivity.',
  'org-reauth': 'That organization requires a recent sign-in. Sign in again, then switch to it.',
};

/** The sign-in page for `reason` (an `idle` one may say how many minutes). */
export function signInHref(reason: SignInReason, opts?: { minutes?: number }): string {
  const minutes = reason === 'idle' ? parseIdleMinutesParam(opts?.minutes) : null;
  return `/?reason=${encodeURIComponent(reason)}${minutes ? `&minutes=${minutes}` : ''}`;
}

/** A whole, positive number of minutes from a query value, or null. */
function parseIdleMinutesParam(value: unknown): number | null {
  const v = Array.isArray(value) ? value[0] : value;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,7}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The words for `reason`. An `idle` sign-out names its timeout when the URL
 * carries a sane one (`minutes`), and stays generic otherwise.
 */
export function signInReasonMessage(reason: SignInReason, minutes?: unknown): string {
  if (reason === 'idle') {
    const n = parseIdleMinutesParam(minutes);
    if (n) return `Signed out after ${n} minute${n === 1 ? '' : 's'} of inactivity.`;
  }
  return SIGN_IN_REASON_MESSAGES[reason];
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
