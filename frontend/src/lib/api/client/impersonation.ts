// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { RefreshingClient } from './refresh';
import {
  IMPERSONATION_REQUEST_KEY,
  getImpersonationSession,
  readStore,
  setImpersonationSession,
  writeStore,
  type ApiRequestOptions,
} from './shared';

/** Upper bound on the server-side revoke when stopping impersonation. Stopping
 *  must never wait on the network longer than this. */
const END_IMPERSONATION_REVOKE_TIMEOUT_MS = 3000;

/**
 * The impersonation layer of the api client: swapping a sysadmin's
 * impersonation token in (memory only), ending it — locally and on the server
 * — and recovering the operator's own session after a page load, including
 * revoking an impersonation session the reload abandoned.
 */
export abstract class ImpersonatingClient extends RefreshingClient {
  private identityChangeListeners: Set<() => void> = new Set();
  /** An impersonation session a reload abandoned; revoked once a session is restored. */
  private orphanedImpersonationRequestId: string | null = null;

  /** Make an API request and return its JSON envelope (see `RequestClient`). */
  abstract request<T>(endpoint: string, options?: ApiRequestOptions): Promise<T>;

  constructor() {
    super();
    if (typeof window === 'undefined') return;
    // A fresh page has no access token: it is memory-only. `restoreSession()`
    // (called once by AuthProvider) trades the refresh cookie for one. That
    // includes a tab that WAS impersonating before the reload: the
    // impersonation token died with the previous page, so the refresh hands
    // back the operator's own session — the impersonation has ended. Its
    // request id survives the reload (it is not a credential) so the restored
    // session can revoke it on the server; see `revokeOrphanedImpersonation`.
    this.orphanedImpersonationRequestId = readStore('session', IMPERSONATION_REQUEST_KEY);
    if (this.orphanedImpersonationRequestId) writeStore('session', IMPERSONATION_REQUEST_KEY, null);
  }

  /**
   * Recover the session after a page load.
   *
   * The access token is memory-only, so a reload starts signed out as far as
   * this client knows — but the browser may still hold the refresh cookie.
   * Trade it for a new access token. Resolves false when there is no session
   * (or the cookie is no longer accepted), which is the signal to show the
   * login screen. Safe to call more than once.
   */
  async restoreSession(): Promise<boolean> {
    if (this.accessToken) return true;
    if (!this.hasSessionMarker()) return false;
    const restored = await this.refreshAccessToken();
    if (restored) this.revokeOrphanedImpersonation();
    return restored;
  }

  /**
   * Revoke, on the server, the impersonation session a reload abandoned in this
   * tab. Its token is already gone (it lived in the previous page's memory), so
   * this only closes the server-side window until its TTL. Best-effort and not
   * awaited: page start-up must never wait on, or fail because of, it.
   */
  private revokeOrphanedImpersonation(): void {
    const requestId = this.orphanedImpersonationRequestId;
    this.orphanedImpersonationRequestId = null;
    if (!requestId || this.isImpersonating()) return;
    this.request(`/api/admin/impersonate/requests/${encodeURIComponent(requestId)}/revoke`, { method: 'POST' })
      .catch(() => { /* already ended, or unreachable — it expires at its TTL */ });
  }

  /**
   * Swap in a sysadmin impersonation access token.
   *
   * Nothing of the operator's is stashed: their refresh token is an HttpOnly
   * cookie this swap never touches, so their own session survives untouched
   * and stopping is just "throw this token away and refresh".
   *
   * The impersonation token is held in MEMORY only (`impersonationSession`),
   * never web storage, so the session is scoped to this tab and this page: the
   * swap happens in place (subscribers of `onIdentityChange` reload the profile
   * and navigate) rather than by reloading, and a reload ends the session —
   * the token is not refreshable (short-lived, read-only), so the next page
   * restores the operator's own session and revokes the abandoned one.
   */
  startImpersonation(impersonationAccessToken: string, requestId?: string): void {
    // A refresh of the operator's session still in flight must not land on top
    // of the impersonation token (see `attemptRefresh`).
    this.sessionGeneration++;
    setImpersonationSession({ accessToken: impersonationAccessToken, requestId: requestId ?? null });
    // Remembered so stopping can end the session on the SERVER, not just
    // discard the token in this browser — and, in the tab's sessionStorage, so
    // a reload can too. Only the id: it is not a credential.
    writeStore('session', IMPERSONATION_REQUEST_KEY, requestId ?? null);
    // Also re-points the cached org at the impersonated user's.
    this.applyAccessToken(impersonationAccessToken);
    // Don't schedule a proactive refresh — `scheduleProactiveRefresh` already
    // declines for an impersonation token, but a timer armed by the operator's
    // own session is still pending here.
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
    this.notifyIdentityChange();
  }

  /**
   * Subscribe to this tab's session switching to ANOTHER PERSON without a page
   * load — an impersonation starting. Everything derived from the previous
   * identity (profile, caches, the current page) must be rebuilt. Returns an
   * unsubscribe.
   */
  onIdentityChange(callback: () => void): () => void {
    this.identityChangeListeners.add(callback);
    return () => { this.identityChangeListeners.delete(callback); };
  }

  private notifyIdentityChange(): void {
    this.identityChangeListeners.forEach((cb) => {
      try { cb(); } catch { /* ignore listener errors */ }
    });
  }

  /**
   * End the impersonation session in this browser: drop its token and pick the
   * operator's own session back up from the refresh cookie, which was never
   * disturbed. A cookie the server no longer accepts means the operator's
   * session ended meanwhile — sign out rather than strand them on a dead
   * token. The sign-in form lives on the landing route '/' (`/login` only
   * records a return path and forwards there); this matches useAuth/useAuthGuard.
   */
  async stopImpersonation(): Promise<void> {
    if (typeof window === 'undefined') return;
    setImpersonationSession(null);
    writeStore('session', IMPERSONATION_REQUEST_KEY, null);
    this.accessToken = null;
    if (await this.restoreSession()) return;
    this.clearTokens();
    window.location.href = '/';
  }

  /**
   * End an impersonation session: restore the operator's own tokens, then revoke
   * the session on the SERVER.
   *
   * `stopImpersonation` alone only discards the token in this browser — the
   * session stays valid until its TTL, and anyone holding the token could keep
   * using it. Revoking closes that.
   *
   * Order matters. The revoke is sent AFTER the operator's tokens are restored,
   * because the impersonation token is read-only and every write under it is
   * rejected. And it is best-effort and time-boxed: getting out of an
   * impersonation session must never hang on, or fail because of, a network call.
   * If the revoke doesn't land, the token is still gone from this browser and the
   * session ends at its TTL.
   */
  async endImpersonation(): Promise<void> {
    if (typeof window === 'undefined') return;
    const requestId = this.getImpersonationRequestId();

    await this.stopImpersonation();
    // Without the operator's own token there is nothing authorized to revoke
    // with; stopImpersonation has already signed out in that case.
    if (!requestId || !this.accessToken) return;

    try {
      await Promise.race([
        this.request(`/api/admin/impersonate/requests/${encodeURIComponent(requestId)}/revoke`, { method: 'POST' }),
        new Promise((resolve) => setTimeout(resolve, END_IMPERSONATION_REVOKE_TIMEOUT_MS)),
      ]);
    } catch {
      // Already ended, or unreachable — either way the operator is out.
    }
  }

  /** The server-side request id of the current impersonation session, or null.
   *  Shown in the banner so the operator can cite it; also what `endImpersonation`
   *  revokes. */
  getImpersonationRequestId(): string | null {
    const session = getImpersonationSession();
    if (!this.isImpersonating() || session?.accessToken !== this.accessToken) return null;
    return session.requestId;
  }
}
