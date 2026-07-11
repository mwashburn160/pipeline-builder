// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AuthTokens, ApiResponse } from '@/types';
import { REFRESH_BUFFER_MS, MAX_REFRESH_ATTEMPTS, API_REQUEST_TIMEOUT_MS } from '../constants';
import { ApiError, StepUpRequiredError } from './errors';
import { API_URL, base64UrlDecode, isStepUpErrorCode } from './util';

/** SSE event received from AI streaming endpoints. */
export interface StreamEvent {
  type: 'partial' | 'done' | 'error' | 'analyzing' | 'analyzed' | 'checking-plugins' | 'creating-plugins';
  data?: unknown;
  message?: string;
}


/**
 * API Client for communicating with the backend
 */
export class ApiCore {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private organizationId: string | null = null;
  private isRefreshing = false;
  private refreshPromise: Promise<boolean> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshAttempts = 0;
  private sessionExpiredCallbacks: Set<() => void> = new Set();

  private static REFRESH_BUFFER_MS = REFRESH_BUFFER_MS;
  private static MAX_REFRESH_ATTEMPTS = MAX_REFRESH_ATTEMPTS;

  /**
   * Register a callback invoked when the session expires (refresh fails).
   * Returns an unsubscribe function.
   */
  onSessionExpired(callback: () => void): () => void {
    this.sessionExpiredCallbacks.add(callback);
    return () => { this.sessionExpiredCallbacks.delete(callback); };
  }

  private notifySessionExpired(): void {
    this.sessionExpiredCallbacks.forEach(cb => {
      try { cb(); } catch { /* ignore listener errors */ }
    });
  }

  constructor() {
    if (typeof window !== 'undefined') {
      this.accessToken = localStorage.getItem('accessToken');
      this.refreshToken = localStorage.getItem('refreshToken');
      this.organizationId = localStorage.getItem('organizationId');
      this.scheduleProactiveRefresh();
    }
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
    if (!expiryMs || !this.refreshToken) return;

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
    if (!this.accessToken || !this.refreshToken) return;

    const expiryMs = this.getTokenExpiryMs();
    if (!expiryMs) return;

    if (expiryMs - Date.now() <= ApiCore.REFRESH_BUFFER_MS) {
      await this.refreshAccessToken();
    }
  }

  /**
   * Set authentication tokens
   */
  setTokens(tokens: AuthTokens) {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;

    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('accessToken', tokens.accessToken);
        localStorage.setItem('refreshToken', tokens.refreshToken);
      } catch {
        // localStorage may be unavailable (Safari private mode, quota exceeded)
      }

      // Extract organizationId from JWT token if present
      try {
        const payload = JSON.parse(base64UrlDecode(tokens.accessToken.split('.')[1]));
        if (payload.organizationId) {
          this.organizationId = payload.organizationId;
          try { localStorage.setItem('organizationId', payload.organizationId); } catch { /* localStorage unavailable */ }
        }
      } catch {
        // JWT parsing failed - non-critical
      }
    }

    this.scheduleProactiveRefresh();
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
   * Swap in a sysadmin impersonation access token. Preserves the original
   * tokens in sessionStorage so `stopImpersonation` can restore them.
   *
   * Refresh token is intentionally cleared during impersonation — the
   * impersonation token is short-lived (15min) and not refreshable; the
   * sysadmin re-prompts (or stops) when it expires.
   */
  startImpersonation(impersonationAccessToken: string): void {
    if (typeof window !== 'undefined') {
      try {
        const originalAccess = localStorage.getItem('accessToken');
        const originalRefresh = localStorage.getItem('refreshToken');
        const originalOrgId = localStorage.getItem('organizationId');
        if (originalAccess) sessionStorage.setItem('impersonation.originalAccess', originalAccess);
        if (originalRefresh) sessionStorage.setItem('impersonation.originalRefresh', originalRefresh);
        if (originalOrgId) sessionStorage.setItem('impersonation.originalOrgId', originalOrgId);
      } catch {
        // storage may be unavailable; impersonation still works for the current tab
      }
    }
    this.accessToken = impersonationAccessToken;
    this.refreshToken = null;
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('accessToken', impersonationAccessToken);
        localStorage.removeItem('refreshToken');
      } catch { /* localStorage unavailable */ }
      // Update the cached organizationId to the impersonated user's.
      try {
        const payload = JSON.parse(base64UrlDecode(impersonationAccessToken.split('.')[1]));
        if (payload.organizationId) {
          this.organizationId = payload.organizationId;
          try { localStorage.setItem('organizationId', payload.organizationId); } catch { /* localStorage unavailable */ }
        }
      } catch { /* non-critical */ }
    }
    // Don't schedule proactive refresh — there's no refresh token.
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
  }

  /** Restore the sysadmin's original tokens, ending the impersonation session. */
  stopImpersonation(): void {
    if (typeof window === 'undefined') return;
    const originalAccess = sessionStorage.getItem('impersonation.originalAccess');
    const originalRefresh = sessionStorage.getItem('impersonation.originalRefresh');
    const originalOrgId = sessionStorage.getItem('impersonation.originalOrgId');
    if (!originalAccess || !originalRefresh) {
      // Lost the original tokens — fall back to a hard sign-out. Better
      // than leaving the sysadmin stuck in the impersonation token. The login
      // screen is the landing route '/' (there is no '/login' page — that path
      // 404s); this matches the sign-out redirect used by useAuth/useAuthGuard.
      this.clearTokens();
      window.location.href = '/';
      return;
    }
    this.setTokens({ accessToken: originalAccess, refreshToken: originalRefresh });
    if (originalOrgId) this.setOrganizationId(originalOrgId);
    sessionStorage.removeItem('impersonation.originalAccess');
    sessionStorage.removeItem('impersonation.originalRefresh');
    sessionStorage.removeItem('impersonation.originalOrgId');
  }

  /** True if the current access token is an impersonation token. */
  isImpersonating(): boolean {
    if (!this.accessToken) return false;
    try {
      const payload = JSON.parse(base64UrlDecode(this.accessToken.split('.')[1]));
      return payload.impersonationReadOnly === true;
    } catch { return false; }
  }

  /** The impersonated user's id (sub) from the current token, or null. */
  getImpersonatedUserId(): string | null {
    if (!this.isImpersonating()) return null;
    try {
      const payload = JSON.parse(base64UrlDecode(this.accessToken!.split('.')[1]));
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch { return null; }
  }

  /**
   * Clear all authentication data
   */
  clearTokens() {
    this.accessToken = null;
    this.refreshToken = null;
    this.organizationId = null;

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (typeof window !== 'undefined') {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('organizationId');
    }
  }

  /**
   * Get current access token
   */
  getAccessToken() {
    return this.accessToken;
  }

  getRefreshToken() {
    return this.refreshToken;
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated() {
    return !!this.accessToken;
  }

  /** If response contains tokens, store them. */
  applyTokens(response: ApiResponse<{ accessToken: string; refreshToken: string }>): void {
    const tokens = response.data;
    if (response.success && tokens?.accessToken && tokens?.refreshToken) {
      this.setTokens(tokens);
    }
  }

  /** Build auth + org headers for the current session. */
  authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;
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
    options: RequestInit = {},
    _retryCount = 0,
  ): Promise<T> {
    // Proactively refresh token before it expires (skip for auth endpoints)
    if (!endpoint.includes('/auth/')) {
      await this.ensureFreshToken();
    }

    const url = `${API_URL}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.authHeaders(),
      ...(options.headers as Record<string, string>),
    };

    // Apply default timeout unless caller already provided an AbortSignal
    const controller = options.signal ? undefined : new AbortController();
    const timeoutId = controller ? setTimeout(() => controller.abort(`Request timeout after ${API_REQUEST_TIMEOUT_MS}ms`), API_REQUEST_TIMEOUT_MS) : undefined;

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'same-origin',
      // Never conditionally-cache API responses. Express sets an ETag on every
      // JSON response, so a revalidated GET comes back 304 with an EMPTY body —
      // `response.json()` below then fails and the call looks like a failure
      // (e.g. "Failed to load organization"). `no-store` forces a full 200.
      cache: 'no-store',
      signal: options.signal || controller?.signal,
    }).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
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
    // refreshing won't help, the request needs a fresh step-up. Throw
    // a typed error AND dispatch a window event so a global layout
    // listener can re-prompt automatically (covers stale tabs that
    // fired a destructive call after their local token expired).
    if (statusCode === 401 && isStepUpErrorCode(data.code)) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('step-up-required', {
          detail: { code: data.code, message: data.message, endpoint },
        }));
      }
      throw new StepUpRequiredError(
        data.message || 'Step-up confirmation required',
        String(data.code),
        data.details,
      );
    }

    // Handle 401 - try to refresh token. Recurse into request() so the retry
    // inherits the full contract (step-up handling, 503-loop guard, Retry-After,
    // _retryCount cap) instead of duplicating a one-shot fetch here.
    if (statusCode === 401 && this.refreshToken && !endpoint.includes('/auth/refresh') && _retryCount === 0) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        return this.request<T>(endpoint, options, _retryCount + 1);
      }
    }

    // Retry on 503 (server overloaded / request timeout) — up to 2 retries with
    // backoff. Only for idempotent methods: PATCH is non-idempotent (e.g. a tier
    // or role mutation), so auto-retrying its 503 could apply the change twice.
    if (statusCode === 503 && _retryCount < 2 && !options.method?.match(/POST|PUT|PATCH|DELETE/i)) {
      await new Promise(r => setTimeout(r, 1000 * (_retryCount + 1)));
      return this.request<T>(endpoint, options, _retryCount + 1);
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

  /**
   * Refresh access token using refresh token
   */
  private async refreshAccessToken(): Promise<boolean> {
    // Prevent multiple simultaneous refresh requests
    if (this.isRefreshing && this.refreshPromise) {
      return this.refreshPromise;
    }

    this.isRefreshing = true;
    this.refreshPromise = this.doRefresh();
    
    try {
      return await this.refreshPromise;
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<boolean> {
    if (this.refreshAttempts >= ApiCore.MAX_REFRESH_ATTEMPTS) {
      this.clearTokens();
      this.notifySessionExpired();
      return false;
    }

    this.refreshAttempts++;

    try {
      const response = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });

      const data = await response.json().catch(() => ({ statusCode: response.status }));
      const statusCode = data.statusCode || response.status;

      // Check for tokens in data.data (standardized response) or data directly
      const tokens = data.data || data;

      if (statusCode < 400 && tokens.accessToken) {
        this.refreshAttempts = 0; // Reset on success
        this.setTokens(tokens);
        return true;
      }
    } catch {
      // Refresh failed
    }

    this.clearTokens();
    this.notifySessionExpired();
    return false;
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
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({ message: 'Stream failed' }));
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
