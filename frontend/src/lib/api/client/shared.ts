// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What every layer of the api client shares: the client-identification
 * header, the impersonation session held in page memory, the session-end
 * vocabulary, never-throwing storage accessors, and the request options type.
 */

/**
 * Header that identifies the browser app to the platform. It selects the cookie
 * transport for the refresh token AND is the CSRF proof `/auth/refresh` and
 * `/auth/logout` require — a cross-site form or image cannot set a header.
 */
export const CLIENT_TYPE_HEADER = 'X-Pb-Client';
export const CLIENT_TYPE = 'web';

/**
 * The id of the impersonation session open in this tab — NOT a credential (it
 * authorizes nothing; revoking needs the operator's own token). Kept in
 * tab-scoped sessionStorage only so that, when a reload throws the in-memory
 * token away, the next page can revoke the orphaned session on the server
 * instead of leaving it valid until its TTL.
 */
export const IMPERSONATION_REQUEST_KEY = 'impersonation.requestId';

/**
 * The live impersonation session, held in this page's memory ONLY.
 *
 * Its access token is a bearer credential for someone else's account, so it is
 * kept out of web storage, where any script on the origin (or anyone at the
 * keyboard with devtools) could lift it long after the session was meant to be
 * over. Memory is also exactly the right scope: it is per tab, and a reload —
 * or closing the tab — ends the session, which drops the operator back onto
 * their own (never-disturbed) refresh cookie. See `startImpersonation`.
 */
let impersonationSessionInMemory: { accessToken: string; requestId: string | null } | null = null;

/** The live impersonation session of this page (see above), or null. */
export function getImpersonationSession(): { accessToken: string; requestId: string | null } | null {
  return impersonationSessionInMemory;
}

/** Replace (or, with null, drop) the live impersonation session of this page. */
export function setImpersonationSession(next: { accessToken: string; requestId: string | null } | null): void {
  impersonationSessionInMemory = next;
}

/**
 * An interactive session's idle state, in THIS browser's clock: the effective
 * idle timeout (the strictest of the platform ceiling and the org's policy),
 * the session's last activity as the server recorded it, and the deadline past
 * which the server refuses the next refresh. From the `session` block of every
 * token delivery (sign-in, refresh, switch-org); `null` without an interactive
 * session (signed out). While a tab impersonates it stays the OPERATOR's
 * session's state: that is the session the idle clock is running on.
 */
export interface SessionIdleState {
  idleTimeoutMinutes: number;
  lastActiveAt: number;
  idleExpiresAt: number;
}

/** Extra detail about why a session ended (with {@link SessionEndReason} `idle`). */
export interface SessionEndDetail {
  idleTimeoutMinutes?: number;
}

/** `ApiError.code` when a request needed a token refresh that failed transiently. */
export const SESSION_REFRESH_UNAVAILABLE = 'SESSION_REFRESH_UNAVAILABLE';

/** `/auth/refresh`'s 401 code when the session ran its course (the org's or the
 *  platform's maximum age / idle timeout) — not revoked, not stolen: just over. */
export const SESSION_EXPIRED_CODE = 'SESSION_EXPIRED';

/**
 * Why a session ended, when it is known. `idle`: no real activity for the
 * session's idle timeout — the server refused the refresh for it, or a tab's
 * idle guard signed out at the deadline (every tab is told). `session-expired`:
 * it outlived the rest of the session policy (maximum age). Absent: the
 * refresh cookie was rejected for any other reason (revoked, signed out
 * elsewhere, reuse).
 */
export type SessionEndReason = 'session-expired' | 'idle';

/** Storage accessors that never throw (Safari private mode, blocked cookies/storage). */
export function readStore(store: 'local' | 'session', key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return (store === 'local' ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

/** Returns false when the storage refused the write (unavailable / quota). */
export function writeStore(store: 'local' | 'session', key: string, value: string | null): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const target = store === 'local' ? localStorage : sessionStorage;
    if (value === null) target.removeItem(key);
    else target.setItem(key, value);
    return true;
  } catch {
    // Storage unavailable — the session still works for this tab.
    return false;
  }
}

/** `fetch` options plus the api client's own knobs. */
export interface ApiRequestOptions extends RequestInit {
  /**
   * `false` for a call that must never be replayed by the global step-up dialog
   * — one whose response is a one-time secret, or the start of a browser
   * ceremony. Such a caller asks for the step-up before the call and reports a
   * refusal itself. Defaults to replayable.
   */
  replayOnStepUp?: boolean;
  /**
   * Abort after this many ms (default `API_REQUEST_TIMEOUT_MS`); `null` for no
   * bound — uploads and streamed exports can legitimately run longer. A caller
   * `signal` still cancels either way.
   */
  timeoutMs?: number | null;
  /** Error message when a failed response carries none (non-JSON error body). */
  errorMessage?: string;
}
