// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AuthTokens, ApiResponse } from '@/types';
import { REFRESH_BUFFER_MS, REFRESH_RETRY_DELAYS_MS, REFRESH_FAILURE_COOLDOWN_MS, API_REQUEST_TIMEOUT_MS } from '../constants';
import { ApiError, MfaRequiredError, StepUpRequiredError } from './errors';
import { API_URL, base64UrlDecode, isMfaErrorCode, isStepUpErrorCode } from './util';

/** Upper bound on the server-side revoke when stopping impersonation. Stopping
 *  must never wait on the network longer than this. */
const END_IMPERSONATION_REVOKE_TIMEOUT_MS = 3000;

/** Web Locks name that serializes token refreshes across this browser's tabs. */
const REFRESH_LOCK_NAME = 'pipeline-builder:auth-refresh';

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
 * Header that identifies the browser app to the platform. It selects the cookie
 * transport for the refresh token AND is the CSRF proof `/auth/refresh` and
 * `/auth/logout` require — a cross-site form or image cannot set a header.
 */
const CLIENT_TYPE_HEADER = 'X-Pb-Client';
const CLIENT_TYPE = 'web';

/**
 * Non-secret marker recording that this browser holds a refresh cookie.
 *
 * The cookie is HttpOnly, so a script cannot ask whether a session exists.
 * Without this the landing page would have to probe `/auth/refresh` for every
 * anonymous visitor. It is a hint, never an authority: the server decides.
 */
const SESSION_MARKER_KEY = 'pb.session';

/** Tab-scoped handoff for an impersonation session (see `startImpersonation`). */
const IMPERSONATION_TOKEN_KEY = 'impersonation.accessToken';
const IMPERSONATION_REQUEST_KEY = 'impersonation.requestId';

/** What tabs tell each other on {@link AUTH_CHANNEL_NAME}. */
type AuthBroadcast =
  | { type: 'access-token'; accessToken: string; organizationId: string | null }
  | { type: 'signed-out' };

/** `ApiError.code` when a request needed a token refresh that failed transiently. */
export const SESSION_REFRESH_UNAVAILABLE = 'SESSION_REFRESH_UNAVAILABLE';

/** Storage accessors that never throw (Safari private mode, blocked cookies/storage). */
function readStore(store: 'local' | 'session', key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return (store === 'local' ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function writeStore(store: 'local' | 'session', key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    const target = store === 'local' ? localStorage : sessionStorage;
    if (value === null) target.removeItem(key);
    else target.setItem(key, value);
  } catch {
    // Storage unavailable — the session still works for this tab.
  }
}

/** SSE event received from AI streaming endpoints. */
/** `fetch` options plus the api client's own knobs. */
export interface ApiRequestOptions extends RequestInit {
  /**
   * `false` for a call that must never be replayed by the global step-up dialog
   * — one whose response is a one-time secret, or the start of a browser
   * ceremony. Such a caller asks for the step-up before the call and reports a
   * refusal itself. Defaults to replayable.
   */
  replayOnStepUp?: boolean;
}

export interface StreamEvent {
  type: 'partial' | 'done' | 'error' | 'analyzing' | 'analyzed' | 'checking-plugins' | 'creating-plugins'
    // "Ask" agent stream: grounded sources, answer tokens, tool activity, and
    // reviewable drafts (proposals) from the tool-calling agent.
    | 'sources' | 'token' | 'tool-call' | 'proposal';
  data?: unknown;
  message?: string;
}


/**
 * API Client for communicating with the backend
 */
export class ApiCore {
  /** In memory only — never localStorage. A reload starts with none and calls
   *  `restoreSession()`, which trades the HttpOnly cookie for a new one. */
  private accessToken: string | null = null;
  private organizationId: string | null = null;
  private isRefreshing = false;
  private refreshPromise: Promise<boolean> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** While set (ms timestamp), refreshes short-circuit to `false` without a
   *  network call: the last refresh gave up on transient failures. */
  private refreshCooldownUntil = 0;
  /** Bumped whenever the identity changes (sign-in, sign-out, adoption). An
   *  in-flight refresh that sees it move no longer speaks for the session and
   *  abandons its result — the successor to the old "is this still my refresh
   *  token?" check, which the cookie made impossible to ask. */
  private sessionGeneration = 0;
  private sessionExpiredCallbacks: Set<() => void> = new Set();
  private accessTokenListeners: Set<(token: string | null) => void> = new Set();
  private authChannel: BroadcastChannel | null = null;

  private static REFRESH_BUFFER_MS = REFRESH_BUFFER_MS;

  /**
   * Register a callback invoked when the session expires — the server rejected
   * the refresh token (401/400), or an impersonation token ran out. A refresh
   * that fails transiently (network, 5xx) does NOT fire this.
   * Returns an unsubscribe function.
   */
  onSessionExpired(callback: () => void): () => void {
    this.sessionExpiredCallbacks.add(callback);
    return () => { this.sessionExpiredCallbacks.delete(callback); };
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

  private notifyAccessToken(token: string | null): void {
    this.accessTokenListeners.forEach((cb) => {
      try { cb(token); } catch { /* ignore listener errors */ }
    });
  }

  private notifySessionExpired(): void {
    this.sessionExpiredCallbacks.forEach(cb => {
      try { cb(); } catch { /* ignore listener errors */ }
    });
  }

  constructor() {
    if (typeof window === 'undefined') return;
    this.organizationId = readStore('local', 'organizationId');
    // A fresh page has no access token: it is memory-only. `restoreSession()`
    // (called once by AuthProvider) trades the refresh cookie for one.
    // EXCEPT an impersonation session, whose token is deliberately not
    // refreshable — it rides the operator's intentional reload in tab-scoped
    // sessionStorage, because a refresh would hand back the OPERATOR's session.
    const impersonation = readStore('session', IMPERSONATION_TOKEN_KEY);
    if (impersonation) this.accessToken = impersonation;
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
        this.notifySessionExpired();
        return;
      }
      // An impersonating tab must not be pulled back onto the operator's token.
      if (message.type === 'access-token' && message.accessToken && !this.isImpersonating()) {
        this.sessionGeneration++;
        this.refreshCooldownUntil = 0;
        this.applyAccessToken(message.accessToken);
        if (message.organizationId) this.organizationId = message.organizationId;
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
  private hasSessionMarker(): boolean {
    return readStore('local', SESSION_MARKER_KEY) === '1';
  }

  /**
   * Decode the access token's `exp` claim and return it as a ms timestamp.
   * Returns null if the token is missing or unparseable.
   */
  private getTokenExpiryMs(): number | null {
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

    const delay = expiryMs - Date.now() - ApiCore.REFRESH_BUFFER_MS;
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

    if (expiryMs - Date.now() <= ApiCore.REFRESH_BUFFER_MS) {
      await this.refreshAccessToken();
    }
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
    return this.refreshAccessToken();
  }

  /**
   * Adopt an access token: cache it in memory, pick the active org out of its
   * claims, and re-arm the proactive refresh. Deliberately does NOT touch the
   * session marker or broadcast — see `setTokens`.
   */
  private applyAccessToken(accessToken: string): void {
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
    writeStore('local', SESSION_MARKER_KEY, '1');
    this.applyAccessToken(tokens.accessToken);
    this.broadcast({ type: 'access-token', accessToken: tokens.accessToken, organizationId: this.organizationId });
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

  /**
   * Swap in a sysadmin impersonation access token.
   *
   * Nothing of the operator's is stashed: their refresh token is an HttpOnly
   * cookie this swap never touches, so their own session survives untouched
   * and stopping is just "throw this token away and refresh". The
   * impersonation token itself is kept in TAB-SCOPED sessionStorage because
   * starting a session deliberately reloads the page, and the token is not
   * refreshable (short-lived, 15min, read-only) — a reload that refreshed
   * instead would drop the operator straight back into their own session.
   */
  startImpersonation(impersonationAccessToken: string, requestId?: string): void {
    writeStore('session', IMPERSONATION_TOKEN_KEY, impersonationAccessToken);
    // Remembered so stopping can end the session on the SERVER, not just
    // discard the token in this browser.
    if (requestId) writeStore('session', IMPERSONATION_REQUEST_KEY, requestId);
    // Also re-points the cached org at the impersonated user's, so the reload
    // below comes up in their tenant.
    this.applyAccessToken(impersonationAccessToken);
    // Don't schedule a proactive refresh — `scheduleProactiveRefresh` already
    // declines for an impersonation token, but a timer armed by the operator's
    // own session is still pending here.
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
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
    writeStore('session', IMPERSONATION_TOKEN_KEY, null);
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
    const requestId = readStore('session', IMPERSONATION_REQUEST_KEY);

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

  /** True if the current access token is an impersonation token. */
  isImpersonating(): boolean {
    if (!this.accessToken) return false;
    try {
      const payload = JSON.parse(base64UrlDecode(this.accessToken.split('.')[1]));
      return payload.impersonationReadOnly === true;
    } catch { return false; }
  }

  /** The server-side request id of the current impersonation session, or null.
   *  Shown in the banner so the operator can cite it; also what `endImpersonation`
   *  revokes. */
  getImpersonationRequestId(): string | null {
    if (!this.isImpersonating()) return null;
    return readStore('session', IMPERSONATION_REQUEST_KEY);
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

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    writeStore('local', 'organizationId', null);
    writeStore('local', SESSION_MARKER_KEY, null);
    writeStore('session', IMPERSONATION_TOKEN_KEY, null);
    writeStore('session', IMPERSONATION_REQUEST_KEY, null);
    this.notifyAccessToken(null);
  }

  /**
   * Clear all authentication data, and tell this browser's other tabs — they
   * can no longer discover it for themselves, the way a removed localStorage
   * token used to announce itself through the `storage` event.
   */
  clearTokens() {
    this.resetSession();
    this.broadcast({ type: 'signed-out' });
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

  /**
   * Make an API request.
   *
   * Contract (relied on by every consumer of this client):
   *  - On HTTP 4xx/5xx: throws `ApiError` (or a subclass: `ConflictError`
   *    for registry 409s). The thrown error carries `statusCode`, `code`,
   *    and `details` for inspection (e.g. branch on `statusCode === 413` for
   *    blob-too-large).
   *  - On 401: transparently refreshes the access token once and retries.
   *  - On 503: retries up to 2 times with backoff (read-only requests only).
   *  - On success (2xx): returns the parsed JSON envelope — typically
   *    `ApiResponse<X>` with `success: true` and `data: X`.
   *
   * Because of the throw-on-error contract, callers may treat the return
   * value's `success` field as effectively always-true and access `data`
   * directly (the discriminated union in `ApiResponse<T>` allows this
   * after a narrowing check; most call sites skip the check entirely).
   *
   * Exceptions to the envelope return shape are documented at the
   * individual method (e.g. `getImageBlob` returns the raw blob JSON,
   * `getNotificationTicket` early-unwraps the ticket string).
   */
  async request<T>(
    endpoint: string,
    options: ApiRequestOptions = {},
    _retryCount = 0,
    // Tracked separately from `_retryCount` so a 503 retry (which bumps
    // `_retryCount`) can't consume the one-shot 401 token-refresh — a GET that
    // 503s then 401s on retry must still refresh once, not surface a spurious auth error.
    _refreshed = false,
  ): Promise<T> {
    // Proactively refresh token before it expires (skip for auth endpoints)
    if (!endpoint.includes('/auth/')) {
      await this.ensureFreshToken();
    }

    const url = `${API_URL}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Sent on every request: it names the transport the platform should use
      // for session tokens, and `/auth/refresh` + `/auth/logout` refuse without
      // it (CSRF). Same-origin, so it never provokes a preflight.
      [CLIENT_TYPE_HEADER]: CLIENT_TYPE,
      ...this.authHeaders(),
      ...(options.headers as Record<string, string>),
    };

    // One controller carries BOTH cancellation sources. A caller-supplied signal
    // used to REPLACE the timeout entirely, so every cancellable call site
    // silently opted out of the 30s bound and could hang forever; linking them
    // means a caller can cancel AND the timeout still applies. The link is
    // manual rather than `AbortSignal.any` because that is missing from the
    // jsdom build the suites run under.
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(`Request timeout after ${API_REQUEST_TIMEOUT_MS}ms`),
      API_REQUEST_TIMEOUT_MS,
    );
    const callerSignal = options.signal;
    const onCallerAbort = () => controller.abort(callerSignal!.reason);
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }

    // Client-only knobs never reach `fetch`.
    const { replayOnStepUp, ...init } = options;
    const response = await fetch(url, {
      ...init,
      headers,
      credentials: 'same-origin',
      // Never conditionally-cache API responses. Express sets an ETag on every
      // JSON response, so a revalidated GET comes back 304 with an EMPTY body —
      // `response.json()` below then fails and the call looks like a failure
      // (e.g. "Failed to load organization"). `no-store` forces a full 200.
      cache: 'no-store',
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    });

    // Parse the JSON envelope. A parse failure is recorded — not papered over
    // with a fabricated `{success:false}` object — so a 2xx with an
    // unparseable/empty body surfaces as a thrown ApiError below instead of a
    // silent "success:false, statusCode:200" the caller ignores.
    let raw: unknown;
    let parseFailed = false;
    try {
      raw = await response.json();
    } catch {
      raw = {};
      parseFailed = true;
    }
    const data = raw as {
      statusCode?: number;
      message?: string;
      code?: string;
      details?: Record<string, unknown>;
      data?: unknown;
    };

    // Success/failure is decided by the REAL HTTP status, never a body
    // `statusCode` field — a proxy or error page may omit/lie about it, and it
    // must never override a genuine 4xx/5xx. (`no-store` above already forces a
    // full 200 body rather than an empty 304, so a 2xx here means real content.)
    const statusCode = response.status;

    // Step-up rejection: don't trigger the access-token refresh dance —
    // refreshing won't help, the request needs a fresh step-up.
    if (statusCode === 401 && isStepUpErrorCode(data.code)) {
      const error = new StepUpRequiredError(
        data.message || 'Step-up confirmation required',
        String(data.code),
        data.details,
      );
      // A call whose RESULT is a one-time secret or the start of a browser
      // ceremony (access / service-account / SCIM keys, recovery codes, TOTP
      // enrolment, passkey registration options) is never replayed from the
      // global dialog: the replay's secret would land nowhere, and a WebAuthn
      // ceremony needs the click that started it. Those callers ask for the
      // step-up FIRST and surface a refusal themselves.
      if (typeof window !== 'undefined' && replayOnStepUp !== false) {
        this.offerStepUpResume<T>(error, endpoint, data, options, _retryCount, _refreshed);
      }
      throw error;
    }

    // MFA refusal (#8): the session is genuinely valid, it is just not strong
    // (or not recent) enough for this route. Handled BEFORE the refresh dance
    // because a refresh can never raise a session's assurance — it would be a
    // wasted round trip that fails identically — and before the sign-out paths
    // below, because signing the person out would take away the very session
    // they need in order to enrol a factor.
    if (statusCode === 401 && isMfaErrorCode(data.code)) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('mfa-required', {
          detail: { code: data.code, message: data.message, endpoint },
        }));
      }
      throw new MfaRequiredError(
        data.message || 'Two-factor authentication is required',
        String(data.code),
        data.details,
      );
    }

    // Handle 401 - try to refresh token. Recurse into request() so the retry
    // inherits the full contract (step-up handling, 503-loop guard, Retry-After,
    // _retryCount cap) instead of duplicating a one-shot fetch here.
    if (statusCode === 401 && this.canRefresh() && !endpoint.includes('/auth/refresh') && !_refreshed) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        // Reuse `_retryCount`: this is a re-auth, not an overload retry, and
        // charging it against the 503 budget cost a refreshed GET one of its
        // two documented 503 retries. The `_refreshed` flag already prevents a
        // refresh loop.
        return this.request<T>(endpoint, options, _retryCount, true);
      }
      this.throwIfRefreshUnavailable();
    }

    // An impersonation session is deliberately NOT refreshable, so the branch
    // above is skipped once its short-lived token expires: every request 401s,
    // `notifySessionExpired` never fires, and the dashboard dead-ends with
    // generic auth errors on every panel. Treat it as what it is — an expired
    // session — so the app routes back to the operator's own session.
    if (statusCode === 401 && this.isImpersonating()) {
      this.notifySessionExpired();
    }

    // Retry on 503 (server overloaded / request timeout) — up to 2 retries with
    // backoff. Only for idempotent methods: PATCH is non-idempotent (e.g. a tier
    // or role mutation), so auto-retrying its 503 could apply the change twice.
    if (statusCode === 503 && _retryCount < 2 && !options.method?.match(/POST|PUT|PATCH|DELETE/i)) {
      await new Promise(r => setTimeout(r, 1000 * (_retryCount + 1)));
      return this.request<T>(endpoint, options, _retryCount + 1, _refreshed);
    }

    // Check statusCode from response body
    if (statusCode >= 400) {
      // Strip HTML tags from server error messages to prevent XSS
      const safeMessage = typeof data.message === 'string'
        ? data.message.replace(/<[^>]*>/g, '')
        : 'Request failed';
      const error = new ApiError(
        safeMessage,
        statusCode,
        data.code,
        data.details
      );
      // Extract Retry-After header for rate-limited responses
      if (statusCode === 429) {
        const retryAfter = response.headers.get('Retry-After');
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          error.retryAfter = Number.isFinite(parsed) ? parsed : undefined;
        }
      }
      throw error;
    }

    // 2xx but the body didn't parse (truncated/empty/proxy-mangled). Don't
    // return a fabricated envelope the caller treats as success — surface it.
    if (parseFailed) {
      throw new ApiError(
        `Malformed response body (HTTP ${statusCode})`,
        statusCode,
        'MALFORMED_RESPONSE',
      );
    }

    return data as unknown as T;
  }

  /** True when a refresh could plausibly succeed: a session cookie is believed
   *  to exist and this isn't a (non-refreshable) impersonation session. */
  private canRefresh(): boolean {
    return this.hasSessionMarker() && !this.isImpersonating();
  }

  /**
   * Refresh the access token by presenting the HttpOnly cookie.
   */
  private async refreshAccessToken(): Promise<boolean> {
    // Prevent multiple simultaneous refresh requests
    if (this.isRefreshing && this.refreshPromise) {
      return this.refreshPromise;
    }

    // Captured BEFORE the cross-tab lock: if it has changed by the time the
    // lock is ours, a sibling tab refreshed while we queued.
    const tokenBeforeLock = this.accessToken;
    this.isRefreshing = true;
    this.refreshPromise = this.withCrossTabRefreshLock(() => this.doRefresh(tokenBeforeLock));

    try {
      return await this.refreshPromise;
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
    }
  }

  /**
   * One refresh, retried with backoff on transient failures.
   *
   * Only a definitive rejection of the refresh cookie — HTTP 401 or 400 from
   * `/auth/refresh` — ends the session (session cleared, `onSessionExpired`
   * fired). A network error, 5xx or 429 is retried per
   * `REFRESH_RETRY_DELAYS_MS`; if every attempt fails the session is KEPT, the
   * refresh reports `false` (so the caller's request surfaces its own error),
   * and further refreshes pause for `REFRESH_FAILURE_COOLDOWN_MS` before the
   * proactive timer tries again. An outage must not log everybody out.
   */
  private async doRefresh(tokenBeforeLock: string | null): Promise<boolean> {
    if (!this.canRefresh()) return false;
    if (Date.now() < this.refreshCooldownUntil) return false;
    // A sibling tab won the lock and broadcast its new access token. Take that
    // instead of rotating the shared cookie a second time for nothing.
    if (this.accessToken && this.accessToken !== tokenBeforeLock && !this.isExpiringSoon()) return true;

    const generation = this.sessionGeneration;
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.attemptRefresh();
      if (outcome === 'ok') return true;
      // The session changed underneath us (logout, re-login, another tab):
      // this refresh no longer speaks for the current session.
      if (this.sessionGeneration !== generation) return false;
      if (outcome === 'rejected') {
        this.clearTokens();
        this.notifySessionExpired();
        return false;
      }
      if (outcome === 'failed' || attempt >= REFRESH_RETRY_DELAYS_MS.length) break;
      await new Promise((r) => setTimeout(r, REFRESH_RETRY_DELAYS_MS[attempt]));
      if (this.sessionGeneration !== generation) return false;
    }

    this.refreshCooldownUntil = Date.now() + REFRESH_FAILURE_COOLDOWN_MS;
    this.scheduleRefreshAfterCooldown();
    return false;
  }

  /** True when the current access token is missing or inside the refresh window. */
  private isExpiringSoon(): boolean {
    const expiryMs = this.getTokenExpiryMs();
    return !expiryMs || expiryMs - Date.now() <= ApiCore.REFRESH_BUFFER_MS;
  }

  /**
   * Serialize refreshes across tabs (Web Locks).
   *
   * Load-bearing now that the refresh token is a shared cookie: the lock is
   * what guarantees a sibling's rotation has LANDED (its Set-Cookie applied)
   * before the next tab presents a cookie — two tabs firing together could
   * otherwise both send the pre-rotation token, which the server reads as
   * reuse and answers by revoking the slot. Without Web Locks the adoption
   * check in `doRefresh` still covers the common case.
   */
  private withCrossTabRefreshLock(fn: () => Promise<boolean>): Promise<boolean> {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks?.request) return fn();
    return locks.request(REFRESH_LOCK_NAME, fn);
  }

  /**
   * A single POST to `/auth/refresh`. The refresh token itself is not sent —
   * the browser attaches the HttpOnly cookie, and `X-Pb-Client` is the header
   * the server demands as CSRF proof.
   *
   *  - `ok`        a new access token was stored (the cookie rotated with it)
   *  - `rejected`  401/400 — the refresh cookie is no good
   *  - `transient` network error, 5xx or 429 — worth retrying
   *  - `failed`    anything else (other 4xx, 2xx without a token) — not retried,
   *                but not proof the session is over either
   */
  private async attemptRefresh(): Promise<'ok' | 'rejected' | 'transient' | 'failed'> {
    let response: Response;
    try {
      response = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [CLIENT_TYPE_HEADER]: CLIENT_TYPE },
        credentials: 'same-origin',
        body: '{}',
      });
    } catch {
      return 'transient';
    }
    // Decide from the REAL HTTP status, never a body `statusCode` field — a proxy
    // may inject/lie about it (mirrors request()).
    const statusCode = response.status;
    if (statusCode === 401 || statusCode === 400) return 'rejected';
    if (statusCode >= 500 || statusCode === 429) return 'transient';

    const data = await response.json().catch(() => ({}));
    // The token lives in data.data (standardized envelope) or on the body itself.
    const tokens = data.data || data;
    if (statusCode < 400 && tokens.accessToken) {
      this.setTokens(tokens);
      return 'ok';
    }
    return 'failed';
  }

  /**
   * A refresh that returned `false` but left the session marker in place failed
   * transiently — the session is intact, the auth service just couldn't be
   * reached. Surface that as a retryable 503 rather than the request's own 401,
   * which callers (useAuth) rightly read as "signed out".
   */
  private throwIfRefreshUnavailable(): void {
    if (!this.hasSessionMarker()) return;
    throw new ApiError(
      'Your session could not be refreshed because the server is unavailable. Try again shortly.',
      503,
      SESSION_REFRESH_UNAVAILABLE,
    );
  }

  /** After a transient give-up, try again once the cooldown ends — if the
   *  session is still worth refreshing by then. */
  private scheduleRefreshAfterCooldown(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshCooldownUntil = 0;
      if (this.canRefresh()) void this.refreshAccessToken();
    }, REFRESH_FAILURE_COOLDOWN_MS);
  }

  /**
   * Hand a step-up refusal to the global dialog (`step-up-required`), and — if
   * a listener takes it (`preventDefault`) — attach the replay to the error as
   * its `resume` promise.
   *
   * RESUME, don't re-ask. The refusal happened BEFORE the server did anything,
   * so replaying the identical request with the fresh token is exactly what the
   * user would do by hand. The replay's RESULT goes back to the code that made
   * the call (`continueAfterStepUp` / `withStepUpResume`), so it can refresh
   * what it shows instead of leaving the page stale while the write succeeded
   * behind it. `cancel` (the dialog closed unconfirmed) rejects the promise with
   * the original refusal.
   */
  private offerStepUpResume<T>(
    error: StepUpRequiredError,
    endpoint: string,
    data: { code?: string; message?: string },
    options: ApiRequestOptions,
    _retryCount: number,
    _refreshed: boolean,
  ): void {
    let settle: { resolve: (v: T) => void; reject: (e: unknown) => void } = { resolve: () => undefined, reject: () => undefined };
    const resume = new Promise<T>((resolve, reject) => { settle = { resolve, reject }; });
    // Nobody is obliged to await it; an unobserved rejection is not an error.
    resume.catch(() => undefined);
    const event = new CustomEvent('step-up-required', {
      cancelable: true,
      detail: {
        code: data.code,
        message: data.message,
        endpoint,
        retry: async (stepUpToken: string) => {
          try {
            const result = await this.request<T>(
              endpoint,
              { ...options, headers: { ...(options.headers as Record<string, string>), ...this.stepUpHeader(stepUpToken) } },
              _retryCount,
              _refreshed,
            );
            settle.resolve(result);
            return result;
          } catch (err) {
            settle.reject(err);
            throw err;
          }
        },
        cancel: () => settle.reject(error),
      },
    });
    window.dispatchEvent(event);
    if (event.defaultPrevented) error.attachResume(resume);
  }

  /** Build the header object an api method threads when called with a
   *  step-up token. Returns an empty object if no token is supplied so
   *  callers can spread it unconditionally. */
  stepUpHeader(token?: string): Record<string, string> {
    return token ? { 'X-Step-Up-Token': token } : {};
  }

  /**
   * Stream SSE events from a POST endpoint.
   * Yields parsed StreamEvent objects as they arrive.
   */
  async *streamRequest(
    endpoint: string,
    body: Record<string, unknown>,
    _refreshed = false,
  ): AsyncGenerator<StreamEvent> {
    await this.ensureFreshToken();

    // Tie the fetch to an AbortController so that when the consumer stops
    // iterating early — component unmount, route change, an upstream `break` —
    // the generator's `finally` aborts the request. Without this the SSE
    // connection (and the server-side work behind it, e.g. a repoToken-
    // authenticated git clone) keeps running after the UI has moved on.
    const controller = new AbortController();
    const response = await fetch(`${API_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CLIENT_TYPE_HEADER]: CLIENT_TYPE, ...this.authHeaders() },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({ message: 'Stream failed' }));
      // Step-up rejection: a refresh won't help — re-prompt (mirrors request()).
      if (response.status === 401 && isStepUpErrorCode(data.code)) {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('step-up-required', {
            detail: { code: data.code, message: data.message, endpoint },
          }));
        }
        throw new StepUpRequiredError(data.message || 'Step-up confirmation required', String(data.code), data.details);
      }
      // MFA refusal on a stream: same reasoning as request() — a refresh cannot
      // raise assurance, so surface it as itself rather than bouncing the person
      // through a re-auth that would fail the same way.
      if (response.status === 401 && isMfaErrorCode(data.code)) {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('mfa-required', {
            detail: { code: data.code, message: data.message, endpoint },
          }));
        }
        throw new MfaRequiredError(data.message || 'Two-factor authentication is required', String(data.code), data.details);
      }
      // 401: refresh the access token once and retry the stream (mirrors request()).
      if (response.status === 401 && this.canRefresh() && !endpoint.includes('/auth/refresh') && !_refreshed) {
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          yield* this.streamRequest(endpoint, body, true);
          return;
        }
        this.throwIfRefreshUnavailable();
      }
      throw new ApiError(data.message || 'Stream failed', response.status, data.code);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') return;
            try {
              yield JSON.parse(data) as StreamEvent;
            } catch { /* skip malformed SSE data */ }
          }
        }
      }
    } finally {
      // Abort first so an early-exit (break/unmount) actually cancels the
      // request; releasing a lock on an aborted stream can throw, so guard it.
      controller.abort();
      try { reader.releaseLock(); } catch { /* already released by abort */ }
    }
  }
}
