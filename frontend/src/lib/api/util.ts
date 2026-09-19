// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Use relative URL in browser (requests go through nginx), absolute URL for SSR
export const API_URL = typeof window !== 'undefined' ? '' : (process.env.PLATFORM_BASE_URL || 'https://localhost:8443');

/** Build a query string from optional params, filtering out undefined/null/empty values. */
export function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return '';
  const entries = Object.entries(params)
    // `v != null` drops both undefined AND null (String(null) → the literal
    // "null", which would otherwise be sent as ?foo=null when a filter clears).
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => [k, String(v)]);
  return entries.length ? '?' + new URLSearchParams(entries).toString() : '';
}

export function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return atob(base64);
}

/** True iff the backend error code indicates the request needs a fresh step-up. */
export function isStepUpErrorCode(code?: string): boolean {
  return code === 'STEP_UP_REQUIRED'
    || code === 'STEP_UP_INVALID'
    || code === 'STEP_UP_MISMATCH'
    || code === 'STEP_UP_REPLAY'
    // The confirmation was real but earned by the wrong factor (#8): the route
    // demands a passkey or an authenticator code. Same handling — re-prompt —
    // with the modal restricted to those two.
    || code === 'STEP_UP_METHOD_REQUIRED';
}

/**
 * True iff the backend refused because the SESSION is not strong enough (#8),
 * rather than because it is invalid.
 *
 * These 401s must NOT be treated like an expired token: refreshing can never
 * raise a session's assurance level or reset its sign-in time, so a refresh
 * would burn a round trip and then fail again. The answer is to send the person
 * to enrolment (`MFA_REQUIRED`) or to a fresh sign-in (`REAUTH_REQUIRED`) — and
 * never to sign them out, which would lose the very session they need in order
 * to enrol.
 */
export function isMfaErrorCode(code?: string): boolean {
  return code === 'MFA_REQUIRED' || code === 'REAUTH_REQUIRED';
}
