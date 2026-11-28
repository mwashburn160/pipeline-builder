// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { REFRESH_RETRY_DELAYS_MS, REFRESH_FAILURE_COOLDOWN_MS, REFRESH_REQUEST_TIMEOUT_MS, REFRESH_LOCK_WAIT_MS } from '../../constants';
import { activityTracker } from '../../session/activity';
import { ApiError } from '../errors';
import { API_URL, parseRetryAfterSeconds } from '../util';
import { SessionClient } from './session';
import { CLIENT_TYPE, CLIENT_TYPE_HEADER, SESSION_EXPIRED_CODE, SESSION_REFRESH_UNAVAILABLE, type SessionEndReason } from './shared';

/** Web Locks name that serializes token refreshes across this browser's tabs. */
const REFRESH_LOCK_NAME = 'pipeline-builder:auth-refresh';

/**
 * How long a 429 says to wait, in ms.
 *
 * `Retry-After` is seconds or an HTTP date; express-rate-limit also sends
 * `RateLimit-Reset` (seconds until the window rolls) under `standardHeaders`.
 * Clamped so a malformed or hostile value can neither busy-loop the client nor
 * park the session for hours; 0 means "nothing usable was sent".
 */
function retryAfterMs(response: Response): number {
  const CAP_MS = 15 * 60 * 1000;
  const seconds = parseRetryAfterSeconds(response.headers.get('retry-after') ?? response.headers.get('ratelimit-reset'));
  return seconds === undefined ? 0 : Math.min(seconds * 1000, CAP_MS);
}

/**
 * The refresh layer of the api client: trading the HttpOnly refresh cookie
 * for a new access token — one at a time per tab and, through a Web Lock,
 * across this browser's tabs — retried and cooled down on transient failures,
 * and carrying the activity signal that keeps the session's idle clock honest.
 */
export abstract class RefreshingClient extends SessionClient {
  private isRefreshing = false;
  private refreshPromise: Promise<boolean> | null = null;
  /**
   * How long the server told us to wait after a 429 on `/auth/refresh`, read
   * from `Retry-After` / `RateLimit-Reset`. Zero when it said nothing, in which
   * case the ordinary failure cooldown applies.
   */
  private throttledForMs = 0;
  /** Why the last refresh was refused with `SESSION_EXPIRED` (read by `doRefresh`). */
  private lastExpiry: { reason: SessionEndReason; idleTimeoutMinutes?: number } | null = null;
  /** When this page started — input before it is no news to the server unless it says so. */
  private readonly startedAt = Date.now();

  /**
   * The activity signal for the next refresh: `user` when there was real input
   * (in any tab) since the session's last recorded activity — or, before this
   * page knows it, since the page started. Requests (polling) never count.
   */
  private activityForRefresh(): 'user' | 'passive' {
    const baseline = this.sessionIdle?.lastActiveAt ?? this.startedAt;
    return activityTracker.lastActivityAt() > baseline ? 'user' : 'passive';
  }

  /**
   * Tell the server about activity now: a refresh that carries `activity:
   * 'user'` when there was input since the last one ("Stay signed in", or the
   * idle guard keeping the server's clock in step). Resolves like a refresh.
   */
  reportActivity(): Promise<boolean> {
    // An impersonating operator's OWN session keeps its idle clock on the
    // server; their activity must reach it, or ending an impersonation longer
    // than the idle timeout signs an active operator out.
    if (this.isImpersonating()) {
      if (!this.hasSessionMarker()) return Promise.resolve(false);
      return this.withCrossTabRefreshLock(() => this.renewBehindImpersonation());
    }
    if (!this.canRefresh()) return Promise.resolve(false);
    return this.refreshAccessToken();
  }

  /**
   * Renew the operator's session while this tab impersonates: one refresh
   * whose token goes to the sibling tabs (which are on the operator's session)
   * but not to this one, which keeps the impersonation token. Not retried —
   * the idle guard asks again. A refused session ends here like anywhere.
   */
  private async renewBehindImpersonation(): Promise<boolean> {
    if (!this.isImpersonating() || !this.hasSessionMarker()) return false;
    const generation = this.sessionGeneration;
    const outcome = await this.attemptRefresh(generation, { keepAccessToken: true });
    if (outcome === 'ok') return true;
    if (this.sessionGeneration !== generation) return false;
    if (outcome === 'rejected' || outcome === 'expired') this.endRefusedSession(outcome);
    return false;
  }

  /** True when a refresh could plausibly succeed: a session cookie is believed
   *  to exist and this isn't a (non-refreshable) impersonation session. */
  protected canRefresh(): boolean {
    return this.hasSessionMarker() && !this.isImpersonating();
  }

  /**
   * Refresh the access token by presenting the HttpOnly cookie.
   */
  protected async refreshAccessToken(): Promise<boolean> {
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
      const outcome = await this.attemptRefresh(generation);
      if (outcome === 'ok') return true;
      // The session changed underneath us (logout, re-login, another tab):
      // this refresh no longer speaks for the current session.
      if (this.sessionGeneration !== generation) return false;
      if (outcome === 'rejected' || outcome === 'expired') {
        this.endRefusedSession(outcome);
        return false;
      }
      if (outcome === 'throttled') {
        // Wait the server out rather than retrying. Each retry is another
        // request against the very bucket that just refused us, so retrying
        // kept the limit tripped for longer than its own window — the session
        // stayed signed in and unusable.
        this.refreshCooldownUntil = Date.now() + Math.max(REFRESH_FAILURE_COOLDOWN_MS, this.throttledForMs);
        this.scheduleRefreshAfterCooldown();
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

  /** `/auth/refresh` refused the cookie: sign out every tab, saying why when the server did. */
  private endRefusedSession(outcome: 'rejected' | 'expired'): void {
    const end = outcome === 'expired' ? this.lastExpiry ?? { reason: 'session-expired' as const } : undefined;
    this.clearTokens(end);
    if (end?.reason === 'idle') {
      this.notifySessionExpired('idle', end.idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes: end.idleTimeoutMinutes } : {});
    } else {
      this.notifySessionExpired(end?.reason);
    }
  }

  /** True when the current access token is missing or inside the refresh window. */
  private isExpiringSoon(): boolean {
    const expiryMs = this.getTokenExpiryMs();
    return !expiryMs || expiryMs - Date.now() <= SessionClient.REFRESH_BUFFER_MS;
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
    // The wait is BOUNDED. A tab whose refresh never settled (frozen, or a build
    // without REFRESH_REQUEST_TIMEOUT_MS) would otherwise hold the lock for good,
    // and every page load in every other tab would wait on it with no request
    // ever sent. Giving up reports `false` — the same answer as a transient
    // failure: the session marker is kept, nothing is rotated, and the caller
    // shows its signed-out state instead of spinning. Running `fn` WITHOUT the
    // lock is deliberately not the fallback: a stuck holder may still present
    // the pre-rotation cookie, which the server reads as reuse.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_LOCK_WAIT_MS);
    return locks.request(REFRESH_LOCK_NAME, { signal: controller.signal }, async () => {
      clearTimeout(timer);
      return fn();
    }).catch((err: unknown) => {
      if (controller.signal.aborted) return false;
      throw err;
    }).finally(() => clearTimeout(timer));
  }

  /**
   * A single POST to `/auth/refresh`. The refresh token itself is not sent —
   * the browser attaches the HttpOnly cookie, and `X-Pb-Client` is the header
   * the server demands as CSRF proof.
   *
   *  - `ok`        a new access token was stored (the cookie rotated with it)
   *  - `rejected`  401/400 — the refresh cookie is no good
   *  - `expired`   401 `SESSION_EXPIRED` — the cookie was fine, but the session
   *                outlived its policy (maximum age / idle timeout); the person
   *                is told so rather than shown a generic sign-out
   *  - `throttled` 429 — retrying SPENDS MORE of the bucket that just refused
   *                us, so this one backs off for as long as the server asked
   *  - `transient` network error or 5xx — worth retrying
   *  - `failed`    anything else (other 4xx, 2xx without a token) — not retried,
   *                but not proof the session is over either
   */
  private async attemptRefresh(generation: number, opts?: { keepAccessToken?: boolean }): Promise<'ok' | 'rejected' | 'expired' | 'throttled' | 'transient' | 'failed'> {
    let response: Response;
    // Bounded: this runs inside the cross-tab lock, so a request that never
    // settles would hold it for good (see REFRESH_REQUEST_TIMEOUT_MS). A timeout
    // is an outage, not a verdict on the cookie — 'transient', retried, session kept.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_REQUEST_TIMEOUT_MS);
    try {
      response = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [CLIENT_TYPE_HEADER]: CLIENT_TYPE },
        credentials: 'same-origin',
        // No credential — the cookie is one. Only whether the person did
        // anything since the session's last activity: a background poll's
        // refresh must not keep an unattended session alive.
        body: JSON.stringify({ activity: this.activityForRefresh() }),
        signal: controller.signal,
      });
    } catch {
      return 'transient';
    } finally {
      clearTimeout(timer);
    }
    // Decide from the REAL HTTP status, never a body `statusCode` field — a proxy
    // may inject/lie about it (mirrors request()).
    const statusCode = response.status;
    if (statusCode === 401 || statusCode === 400) {
      // The body only refines WHY; any 401/400 ends the session either way.
      type RefusalBody = { code?: unknown; details?: { reason?: unknown; idleTimeoutMinutes?: unknown } } | null;
      const body = await response.json().then((b: unknown) => b as RefusalBody, () => null as RefusalBody); // no/odd body
      if (statusCode === 401 && body?.code === SESSION_EXPIRED_CODE) {
        // Which bound ended it: an idle end says how long, for the sign-in page.
        const minutes = body.details?.idleTimeoutMinutes;
        this.lastExpiry = body.details?.reason === 'idle'
          ? { reason: 'idle', ...(typeof minutes === 'number' ? { idleTimeoutMinutes: minutes } : {}) }
          : { reason: 'session-expired' };
        return 'expired';
      }
      return 'rejected';
    }
    if (statusCode === 429) {
      this.throttledForMs = retryAfterMs(response);
      return 'throttled';
    }
    if (statusCode >= 500) return 'transient';

    const data = await response.json().catch(() => ({}));
    // The token lives in data.data (standardized envelope) or on the body itself.
    const tokens = data.data || data;
    if (statusCode < 400 && tokens.accessToken) {
      // The identity moved while the request was out (a logout, a fresh
      // sign-in, an impersonation starting): this token speaks for the session
      // that WAS, so it must not overwrite — or re-open — the one that is.
      // `doRefresh` sees the generation change and reports false.
      if (this.sessionGeneration !== generation) return 'failed';
      if (opts?.keepAccessToken) this.adoptRenewalElsewhere(tokens);
      else this.setTokens(tokens);
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
  protected throwIfRefreshUnavailable(): void {
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
    // Fire when the cooldown actually ends: a 429's Retry-After can stretch it
    // well past the ordinary failure cooldown.
    const delay = this.refreshCooldownUntil
      ? Math.max(0, this.refreshCooldownUntil - Date.now())
      : REFRESH_FAILURE_COOLDOWN_MS;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshCooldownUntil = 0;
      if (this.canRefresh()) void this.refreshAccessToken();
    }, delay);
  }
}
