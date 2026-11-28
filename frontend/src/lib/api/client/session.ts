// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AuthTokens, ApiResponse } from '@/types';
import { REFRESH_BUFFER_MS } from '../../constants';
import { base64UrlDecode } from '../util';
import {
  IMPERSONATION_REQUEST_KEY,
  readStore,
  setImpersonationSession,
  writeStore,
  type SessionEndDetail,
  type SessionEndReason,
  type SessionIdleState,
} from './shared';

/**
 * BroadcastChannel the tabs of this browser use to share a freshly minted
 * ACCESS token (and to announce a sign-out).
 *
 * The refresh token is an HttpOnly cookie now, so no tab can read it and the
 * old `storage`-event handoff has nothing to hand over. What tabs still need
 * from each other is the short-lived access token the winning refresh produced,
 * so a tab that was waiting doesn't immediately rotate the cookie again.
 */
const AUTH_CHANNEL_NAME = 'pipeline-builder:auth';

/**
 * Non-secret marker recording that this browser holds a refresh cookie.
 *
 * The cookie is HttpOnly, so a script cannot ask whether a session exists.
 * Without this the landing page would have to probe `/auth/refresh` for every
 * anonymous visitor. It is a hint, never an authority: the server decides.
 */
const SESSION_MARKER_KEY = 'pb.session';

/** What tabs tell each other on {@link AUTH_CHANNEL_NAME}. */
type AuthBroadcast =
  | { type: 'access-token'; accessToken: string; organizationId: string | null; sessionIdle?: SessionIdleState | null }
  | { type: 'signed-out'; reason?: SessionEndReason; idleTimeoutMinutes?: number };

/**
 * The session layer of the api client: the in-memory access token and the
 * org it acts for, the listeners told when either changes, the session's idle
 * state, and the cross-tab channel that shares a freshly minted token (or a
 * sign-out) with this browser's other tabs. Refreshing is the next layer's
 * job ({@link RefreshingClient}); this one only schedules it.
 */
export abstract class SessionClient {
  /** In memory only — never localStorage. A reload starts with none and calls
   *  `restoreSession()`, which trades the HttpOnly cookie for a new one. */
  protected accessToken: string | null = null;
  private organizationId: string | null = null;
  protected refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** While set (ms timestamp), refreshes short-circuit to `false` without a
   *  network call: the last refresh gave up on transient failures. */
  protected refreshCooldownUntil = 0;
  /**
   * In-memory stand-in for the `pb.session` marker, set when a sign-in could
   * not persist the marker (storage blocked / throwing). Without it every
   * refresh path would see "no session" and the tab would die with bare 401s
   * at access-token expiry. Only used as a fallback so that, whenever storage
   * works, the shared marker stays the single cross-tab source of truth (a
   * sibling's sign-out clearing it still stops this tab refreshing).
   */
  private sessionInMemory = false;
  /** Bumped whenever the identity changes (sign-in, sign-out, adoption). An
   *  in-flight refresh that sees it move no longer speaks for the session and
   *  abandons its result (an HttpOnly refresh cookie can't be asked "is this
   *  still my token?"). */
  protected sessionGeneration = 0;
  private sessionExpiredCallbacks: Set<(reason?: SessionEndReason, detail?: SessionEndDetail) => void> = new Set();
  /** See {@link SessionIdleState}. */
  protected sessionIdle: SessionIdleState | null = null;
  private sessionIdleListeners: Set<() => void> = new Set();
  private accessTokenListeners: Set<(token: string | null) => void> = new Set();
  private organizationChangeListeners: Set<() => void> = new Set();
  private authChannel: BroadcastChannel | null = null;

  protected static REFRESH_BUFFER_MS = REFRESH_BUFFER_MS;

  /** Refresh the access token by presenting the HttpOnly cookie (see `RefreshingClient`). */
  protected abstract refreshAccessToken(): Promise<boolean>;

  /**
   * Register a callback invoked when the session expires — the server rejected
   * the refresh token (401/400), or an impersonation token ran out. A refresh
   * that fails transiently (network, 5xx) does NOT fire this. The callback is
   * handed a {@link SessionEndReason} when the server named one (a session
   * past its maximum age / idle timeout).
   * Returns an unsubscribe function.
   */
  onSessionExpired(callback: (reason?: SessionEndReason, detail?: SessionEndDetail) => void): () => void {
    this.sessionExpiredCallbacks.add(callback);
    return () => { this.sessionExpiredCallbacks.delete(callback); };
  }

  /** The current session's idle state (see {@link SessionIdleState}). */
  getSessionIdle(): SessionIdleState | null {
    return this.sessionIdle;
  }

  /** Called whenever the idle state changes (a delivery, a sibling's, sign-out). Returns an unsubscribe. */
  onSessionIdleChange(callback: () => void): () => void {
    this.sessionIdleListeners.add(callback);
    return () => { this.sessionIdleListeners.delete(callback); };
  }

  private setSessionIdle(next: SessionIdleState | null): void {
    const prev = this.sessionIdle;
    if (prev === next || (prev && next && prev.idleTimeoutMinutes === next.idleTimeoutMinutes
      && prev.lastActiveAt === next.lastActiveAt && prev.idleExpiresAt === next.idleExpiresAt)) return;
    this.sessionIdle = next;
    this.sessionIdleListeners.forEach((cb) => {
      try { cb(); } catch { /* ignore listener errors */ }
    });
  }

  /**
   * The server's `session` block in this browser's clock. The server's times
   * are in ITS clock; the token's `iat` says what that clock read at the mint,
   * so the difference to ours (plus a request's latency) is the skew to remove.
   */
  private idleStateFrom(accessToken: string, session: AuthTokens['session']): SessionIdleState | null {
    if (!session || typeof session.idleTimeoutMinutes !== 'number') return null;
    const serverDeadline = Date.parse(session.idleExpiresAt);
    if (!Number.isFinite(serverDeadline)) return null;
    let skew = 0;
    try {
      const iat = (JSON.parse(base64UrlDecode(accessToken.split('.')[1])) as { iat?: unknown }).iat;
      if (typeof iat === 'number') skew = Date.now() - iat * 1000;
    } catch { /* undecodable token — assume the clocks agree */ }
    const idleExpiresAt = serverDeadline + skew;
    return {
      idleTimeoutMinutes: session.idleTimeoutMinutes,
      lastActiveAt: idleExpiresAt - session.idleTimeoutMinutes * 60_000,
      idleExpiresAt,
    };
  }

  /**
   * Called with the new access token whenever it changes (sign-in, refresh,
   * org switch, a sibling tab's handoff) and with `null` when the session ends.
   * For state derived from the token OUTSIDE the api client — the admin-console
   * cookie, which must follow the token or be dropped. Returns an unsubscribe.
   */
  onAccessTokenChange(callback: (token: string | null) => void): () => void {
    this.accessTokenListeners.add(callback);
    return () => { this.accessTokenListeners.delete(callback); };
  }

  /**
   * Subscribe to a sibling tab moving the shared session onto another org.
   * The adopted token already sends the new org's id, so everything this tab
   * derived from the old org (profile, role, cached lists) must be reloaded —
   * otherwise it renders org A while its writes land in org B. Returns an
   * unsubscribe.
   */
  onOrganizationChange(callback: () => void): () => void {
    this.organizationChangeListeners.add(callback);
    return () => { this.organizationChangeListeners.delete(callback); };
  }

  private notifyAccessToken(token: string | null): void {
    this.accessTokenListeners.forEach((cb) => {
      try { cb(token); } catch { /* ignore listener errors */ }
    });
  }

  protected notifySessionExpired(reason?: SessionEndReason, detail?: SessionEndDetail): void {
    this.sessionExpiredCallbacks.forEach(cb => {
      try {
        if (detail) cb(reason, detail);
        else cb(reason);
      } catch { /* ignore listener errors */ }
    });
  }

  constructor() {
    if (typeof window === 'undefined') return;
    this.organizationId = readStore('local', 'organizationId');
    this.openAuthChannel();
  }

  /**
   * Listen for the other tabs of this browser.
   *
   * `access-token`: a sibling refreshed — adopt its token rather than rotate
   * the shared cookie a second time. `signed-out`: the session ended
   * elsewhere, so this tab is signed out too.
   */
  private openAuthChannel(): void {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      this.authChannel = new BroadcastChannel(AUTH_CHANNEL_NAME);
    } catch {
      return; // no cross-tab coordination; the Web Lock still serializes refreshes
    }
    this.authChannel.onmessage = (event: MessageEvent<AuthBroadcast>) => {
      const message = event.data;
      if (!message) return;
      if (message.type === 'signed-out') {
        this.resetSession();
        if (message.reason === 'idle') {
          this.notifySessionExpired('idle', typeof message.idleTimeoutMinutes === 'number' ? { idleTimeoutMinutes: message.idleTimeoutMinutes } : {});
        } else {
          this.notifySessionExpired(message.reason);
        }
        return;
      }
      // An impersonating tab must not be pulled back onto the operator's token.
      if (message.type === 'access-token' && message.accessToken && !this.isImpersonating()) {
        const previousOrg = this.organizationId;
        this.sessionGeneration++;
        this.refreshCooldownUntil = 0;
        // A sibling holds a live session; if this tab can't see the shared
        // marker (storage blocked), remember it in memory instead.
        if (readStore('local', SESSION_MARKER_KEY) !== '1') this.sessionInMemory = true;
        this.applyAccessToken(message.accessToken);
        if (message.sessionIdle) this.setSessionIdle(message.sessionIdle);
        if (message.organizationId) this.organizationId = message.organizationId;
        if (this.organizationId !== previousOrg) {
          this.organizationChangeListeners.forEach((cb) => {
            try { cb(); } catch { /* ignore listener errors */ }
          });
        }
      }
    };
  }

  private broadcast(message: AuthBroadcast): void {
    try {
      this.authChannel?.postMessage(message);
    } catch {
      // A closed channel must never break the session it was only informing about.
    }
  }

  /** True when this browser is believed to hold a refresh cookie. */
  protected hasSessionMarker(): boolean {
    return this.sessionInMemory || readStore('local', SESSION_MARKER_KEY) === '1';
  }

  /**
   * Decode the access token's `exp` claim and return it as a ms timestamp.
   * Returns null if the token is missing or unparseable.
   */
  protected getTokenExpiryMs(): number | null {
    if (!this.accessToken) return null;
    try {
      const payload = JSON.parse(base64UrlDecode(this.accessToken.split('.')[1]));
      return payload.exp ? payload.exp * 1000 : null;
    } catch {
      return null;
    }
  }

  /**
   * Schedule a background timer to refresh the token before it expires.
   * Falls back gracefully if the token can't be decoded.
   */
  private scheduleProactiveRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    const expiryMs = this.getTokenExpiryMs();
    // An impersonation token is not refreshable — refreshing would silently
    // restore the operator's own session mid-review.
    if (!expiryMs || !this.hasSessionMarker() || this.isImpersonating()) return;

    const delay = expiryMs - Date.now() - SessionClient.REFRESH_BUFFER_MS;
    if (delay <= 0) return; // already past the refresh window — let the pre-request check handle it

    this.refreshTimer = setTimeout(async () => {
      await this.refreshAccessToken();
    }, delay);
  }

  /**
   * If the token expires within the buffer window, refresh it now.
   * Called before every authenticated request as a safety net.
   */
  async ensureFreshToken(): Promise<void> {
    if (!this.accessToken || this.isImpersonating()) return;

    const expiryMs = this.getTokenExpiryMs();
    if (!expiryMs) return;

    if (expiryMs - Date.now() <= SessionClient.REFRESH_BUFFER_MS) {
      await this.refreshAccessToken();
    }
  }

  /**
   * Adopt an access token: cache it in memory, pick the active org out of its
   * claims, and re-arm the proactive refresh. Deliberately does NOT touch the
   * session marker or broadcast — see `setTokens`.
   */
  protected applyAccessToken(accessToken: string): void {
    this.accessToken = accessToken;
    try {
      const payload = JSON.parse(base64UrlDecode(accessToken.split('.')[1]));
      if (payload.organizationId) {
        this.organizationId = payload.organizationId;
        writeStore('local', 'organizationId', payload.organizationId);
      }
    } catch {
      // JWT parsing failed - non-critical
    }
    this.scheduleProactiveRefresh();
    this.notifyAccessToken(accessToken);
  }

  /**
   * Take the access token a sign-in or refresh produced.
   *
   * There is no refresh token to store: the server put it in an HttpOnly
   * cookie. What IS recorded is the non-secret marker saying a session exists,
   * and the token is shared with this browser's other tabs.
   */
  setTokens(tokens: AuthTokens) {
    this.sessionGeneration++;
    // A fresh session must be refreshable right away, even if the previous
    // one's refresh was cooling down after transient failures.
    this.refreshCooldownUntil = 0;
    // Storage that refuses the marker must not make this session unrefreshable.
    this.sessionInMemory = !writeStore('local', SESSION_MARKER_KEY, '1');
    this.applyAccessToken(tokens.accessToken);
    // A delivery without a `session` block (an endpoint that does not report
    // one) leaves the known idle state as it was.
    const idle = this.idleStateFrom(tokens.accessToken, tokens.session);
    if (idle) this.setSessionIdle(idle);
    this.broadcast({ type: 'access-token', accessToken: tokens.accessToken, organizationId: this.organizationId, sessionIdle: this.sessionIdle });
  }

  /**
   * A renewal of the operator's session made while this tab impersonates: its
   * idle state is the one this tab's guard times, and its token is for the
   * sibling tabs (on the operator's session) — never applied here.
   */
  protected adoptRenewalElsewhere(tokens: AuthTokens): void {
    const idle = this.idleStateFrom(tokens.accessToken, tokens.session);
    if (idle) this.setSessionIdle(idle);
    let organizationId: string | null = null;
    try {
      const claim = (JSON.parse(base64UrlDecode(tokens.accessToken.split('.')[1])) as { organizationId?: unknown }).organizationId;
      if (typeof claim === 'string' && claim) organizationId = claim;
    } catch { /* undecodable — siblings keep their org */ }
    this.broadcast({ type: 'access-token', accessToken: tokens.accessToken, organizationId, sessionIdle: this.sessionIdle });
  }

  /**
   * Set organization ID for API requests
   */
  setOrganizationId(orgId: string) {
    this.organizationId = orgId;
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('organizationId', orgId); } catch { /* localStorage may be unavailable */ }
    }
  }

  /**
   * Get current organization ID
   */
  getOrganizationId() {
    return this.organizationId;
  }

  /** True if the current access token is an impersonation token. */
  isImpersonating(): boolean {
    if (!this.accessToken) return false;
    try {
      const payload = JSON.parse(base64UrlDecode(this.accessToken.split('.')[1]));
      return payload.impersonationReadOnly === true;
    } catch { return false; }
  }

  /**
   * Forget this browser's session locally: the in-memory access token, the
   * cached org, the "a session exists" marker and any impersonation handoff.
   *
   * The refresh COOKIE is not script-reachable, so only the server can drop it
   * — `/auth/logout`, `/auth/refresh`'s rejection and account deletion all do.
   */
  private resetSession(): void {
    this.sessionGeneration++;
    this.accessToken = null;
    this.organizationId = null;
    this.refreshCooldownUntil = 0;
    this.sessionInMemory = false;

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    writeStore('local', 'organizationId', null);
    writeStore('local', SESSION_MARKER_KEY, null);
    setImpersonationSession(null);
    writeStore('session', IMPERSONATION_REQUEST_KEY, null);
    this.setSessionIdle(null);
    this.notifyAccessToken(null);
  }

  /**
   * Clear all authentication data, and tell this browser's other tabs — with
   * the token in memory and the refresh token an HttpOnly cookie, they can't
   * discover it for themselves. `end` says why (an inactivity sign-out), so
   * every tab lands on the sign-in page with the same explanation.
   */
  clearTokens(end?: { reason: SessionEndReason; idleTimeoutMinutes?: number }) {
    this.resetSession();
    this.broadcast({ type: 'signed-out', ...(end ?? {}) });
  }

  /**
   * Get current access token
   */
  getAccessToken() {
    return this.accessToken;
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated() {
    return !!this.accessToken;
  }

  /** If response contains an access token, store it. */
  applyTokens(response: ApiResponse<{ accessToken: string; expiresIn?: number }>): void {
    const tokens = response.data;
    if (response.success && tokens?.accessToken) {
      this.setTokens(tokens);
    }
  }

  /** Build auth + org headers for the current session. */
  authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    if (this.organizationId) headers['x-org-id'] = this.organizationId;
    return headers;
  }
}
