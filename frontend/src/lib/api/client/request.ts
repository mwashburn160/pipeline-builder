// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ASK_AGENT_PROPOSER } from '@pipeline-builder/api-core/ask-proposals';
import { API_REQUEST_TIMEOUT_MS } from '../../constants';
import { ApiError, MfaRequiredError, QuotaExceededError, StepUpRequiredError } from '../errors';
import { API_URL, isAccessTokenRefusal, isMfaErrorCode, isStepUpErrorCode, parseRetryAfterSeconds, type ProposedByOptions } from '../util';
import { ImpersonatingClient } from './impersonation';
import { CLIENT_TYPE, CLIENT_TYPE_HEADER, type ApiRequestOptions } from './shared';

/** Reads a successful response into the caller's result type. */
type ResponseReader<R> = (response: Response) => Promise<R>;

/** `filename="…"` from a Content-Disposition header (the server sanitizes it). */
export function dispositionFilename(response: Response): string | undefined {
  return /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1];
}

/** Parse the JSON envelope of a 2xx; a body that won't parse is an error, not a fake success. */
const readEnvelope = async <T>(response: Response): Promise<T> => {
  try {
    return await response.json() as T;
  } catch {
    throw new ApiError(`Malformed response body (HTTP ${response.status})`, response.status, 'MALFORMED_RESPONSE');
  }
};

/**
 * A server error message with any HTML tags removed (an error page from a proxy
 * can put markup where the envelope's sentence belongs); `''` for a missing or
 * non-string message.
 */
export function stripTags(message: unknown): string {
  return typeof message === 'string' ? message.replace(/<[^>]*>/g, '') : '';
}

/** True for a method that changes server state, which the client never re-issues on its own. */
function isMutatingMethod(method: string | undefined): boolean {
  return /POST|PUT|PATCH|DELETE/i.test(method ?? '');
}

/**
 * The request layer of the api client: one request/response contract for
 * every call — auth headers, timeout and cancellation, the 401 refresh-and-
 * retry, step-up and MFA classification, 503 backoff, quota notices, and the
 * `ApiError` built from the error envelope.
 */
export class RequestClient extends ImpersonatingClient {
  /**
   * Make an API request and return its JSON envelope.
   *
   * Contract (relied on by every consumer of this client):
   *  - On HTTP 4xx/5xx: throws `ApiError`, or the subclass for a refusal the
   *    caller handles differently — `StepUpRequiredError`, `MfaRequiredError`,
   *    `QuotaExceededError` (the registry domain further narrows its 409s to
   *    `ConflictError`). The thrown error carries `statusCode`, `code`,
   *    `details`, and `retryAfter` (seconds) on a 429/503 that sent one.
   *  - On a 401 that says the access token is no good (`TOKEN_EXPIRED`,
   *    `TOKEN_INVALID`, `TOKEN_MISSING`, `TOKEN_REVOKED`): transparently
   *    refreshes the access token once and retries. Any other 401 — a refused
   *    credential above all — is thrown as itself, never re-sent.
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
  request<T>(endpoint: string, options: ApiRequestOptions = {}): Promise<T> {
    return this.send(endpoint, options, readEnvelope<T>);
  }

  /**
   * The same request contract as {@link request} for an endpoint whose success
   * body is NOT the JSON envelope (a file, text, YAML) or whose request body is
   * multipart: resolves with the untouched `Response` of a 2xx. Every failure
   * still goes through the shared handling — 401 refresh, step-up and MFA
   * classification, 503 retry, `ApiError` from the error envelope.
   */
  requestRaw(endpoint: string, options: ApiRequestOptions = {}): Promise<Response> {
    return this.send(endpoint, options, async (response) => response);
  }

  /** A file download: the body as a Blob plus the server's filename (or `fallbackName`). */
  requestBlob(endpoint: string, fallbackName: string, options: ApiRequestOptions = {}): Promise<{ blob: Blob; filename: string }> {
    return this.send(endpoint, options, async (response) => ({
      blob: await response.blob(),
      filename: dispositionFilename(response) ?? fallbackName,
    }));
  }

  /** A text body (plain text, YAML, a raw JSON document). */
  requestText(endpoint: string, options: ApiRequestOptions = {}): Promise<string> {
    return this.send(endpoint, options, (response) => response.text());
  }

  private async send<R>(
    endpoint: string,
    options: ApiRequestOptions,
    read: ResponseReader<R>,
    _retryCount = 0,
    // Tracked separately from `_retryCount` so a 503 retry (which bumps
    // `_retryCount`) can't consume the one-shot 401 token-refresh — a GET that
    // 503s then 401s on retry must still refresh once, not surface a spurious auth error.
    _refreshed = false,
  ): Promise<R> {
    // Proactively refresh token before it expires (skip for auth endpoints)
    if (!endpoint.includes('/auth/')) {
      await this.ensureFreshToken();
    }

    const url = `${API_URL}${endpoint}`;
    // The credential this attempt goes out with — compared on a 401 to tell a
    // stale-identity refusal from a genuinely expired session.
    const sentToken = this.accessToken;

    const headers: Record<string, string> = {
      // A multipart body sets its own Content-Type (with the boundary).
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      // Sent on every request: it names the transport the platform should use
      // for session tokens, and `/auth/refresh` + `/auth/logout` refuse without
      // it (CSRF). Same-origin, so it never provokes a preflight.
      [CLIENT_TYPE_HEADER]: CLIENT_TYPE,
      ...this.authHeaders(),
      ...(options.headers as Record<string, string>),
    };

    // One controller carries BOTH cancellation sources, so a caller can cancel
    // AND the timeout still applies. The link is manual rather than
    // `AbortSignal.any` because that is missing from the jsdom build the suites
    // run under.
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs === undefined ? API_REQUEST_TIMEOUT_MS : options.timeoutMs;
    const timeoutId = timeoutMs === null
      ? undefined
      : setTimeout(() => controller.abort(`Request timeout after ${timeoutMs}ms`), timeoutMs);
    const callerSignal = options.signal;
    const onCallerAbort = () => controller.abort(callerSignal!.reason);
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }

    // Client-only knobs never reach `fetch`.
    const { replayOnStepUp, timeoutMs: _timeoutMs, errorMessage, ...init } = options;
    const response = await fetch(url, {
      ...init,
      headers,
      credentials: 'same-origin',
      // Never conditionally-cache API responses. Express sets an ETag on every
      // JSON response, so a revalidated GET would come back 304 with an EMPTY
      // body the envelope parse can't read. `no-store` forces a full 200.
      cache: 'no-store',
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    });

    // Success/failure is decided by the REAL HTTP status, never a body
    // `statusCode` field — a proxy or error page may omit/lie about it, and it
    // must never override a genuine 4xx/5xx.
    const statusCode = response.status;
    if (statusCode < 400) return read(response);

    const data = await response.json().catch(() => ({})) as {
      message?: string;
      code?: string;
      details?: Record<string, unknown>;
    };

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
        this.offerStepUpResume(error, endpoint, data, options, read, _retryCount, _refreshed);
      }
      throw error;
    }

    // MFA refusal: the session is genuinely valid, it is just not strong (or
    // not recent) enough for this route. Handled BEFORE the refresh dance
    // because a refresh can never raise a session's assurance — it would be a
    // wasted round trip that fails identically — and before the sign-out paths
    // below, because signing the person out would take away the very session
    // they need in order to enrol a factor.
    if (statusCode === 401 && isMfaErrorCode(data.code)) {
      throw this.mfaRequired(data, endpoint);
    }

    // Only a 401 about the ACCESS TOKEN is the session's problem. Any other 401
    // (a wrong code, password or passkey) is the answer to what the request
    // carried: refreshing would re-POST the same refused credential.
    const tokenRefused = statusCode === 401 && isAccessTokenRefusal(data.code);

    // Handle 401 - try to refresh token. Recurse so the retry inherits the full
    // contract (step-up handling, 503-loop guard, Retry-After, _retryCount cap)
    // instead of duplicating a one-shot fetch here.
    if (tokenRefused && this.canRefresh() && !endpoint.includes('/auth/refresh') && !_refreshed) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        // Reuse `_retryCount`: this is a re-auth, not an overload retry, so it
        // must not be charged against the 503 budget. The `_refreshed` flag
        // already prevents a refresh loop.
        return this.send(endpoint, options, read, _retryCount, true);
      }
      // The refresh was dropped because the session's identity changed while
      // it was out (org switch, impersonation start, a new sign-in): this 401
      // answered the OLD token, and a session token is already current. Retry
      // once with it rather than reporting an outage. Only for idempotent
      // methods — a mutation is never silently re-issued under a different
      // identity than the one it was made as. `_refreshed = true` makes it
      // one-shot, and a logout leaves no token, so it can't fire after one.
      if (this.accessToken && this.accessToken !== sentToken && !isMutatingMethod(options.method)) {
        return this.send(endpoint, options, read, _retryCount, true);
      }
      this.throwIfRefreshUnavailable();
    }

    // An impersonation session is deliberately NOT refreshable, so the branch
    // above is skipped once its short-lived token expires: every request 401s,
    // `notifySessionExpired` never fires, and the dashboard dead-ends with
    // generic auth errors on every panel. Treat it as what it is — an expired
    // session — so the app routes back to the operator's own session.
    if (tokenRefused && this.isImpersonating()) {
      this.notifySessionExpired();
    }

    // Retry on 503 (server overloaded / request timeout) — up to 2 retries with
    // backoff. Only for idempotent methods: PATCH is non-idempotent (e.g. a tier
    // or role mutation), so auto-retrying its 503 could apply the change twice.
    if (statusCode === 503 && _retryCount < 2 && !isMutatingMethod(options.method)) {
      await new Promise(r => setTimeout(r, 1000 * (_retryCount + 1)));
      return this.send(endpoint, options, read, _retryCount + 1, _refreshed);
    }

    const safeMessage = stripTags(data.message) || (errorMessage ?? 'Request failed');
    const error = statusCode === 429 && data.code === 'QUOTA_EXCEEDED'
      ? this.quotaExceeded(safeMessage, data.details)
      : new ApiError(safeMessage, statusCode, data.code, data.details);
    // Extract Retry-After header for rate-limited responses (and a busy AI
    // provider's 503, which carries the provider's own Retry-After).
    if (statusCode === 429 || statusCode === 503) {
      error.retryAfter = parseRetryAfterSeconds(response.headers.get('Retry-After'));
    }
    throw error;
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
  private offerStepUpResume<R>(
    error: StepUpRequiredError,
    endpoint: string,
    data: { code?: string; message?: string },
    options: ApiRequestOptions,
    read: ResponseReader<R>,
    _retryCount: number,
    _refreshed: boolean,
  ): void {
    let settle: { resolve: (v: R) => void; reject: (e: unknown) => void } = { resolve: () => undefined, reject: () => undefined };
    const resume = new Promise<R>((resolve, reject) => { settle = { resolve, reject }; });
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
            const result = await this.send(
              endpoint,
              { ...options, headers: { ...(options.headers as Record<string, string>), ...this.stepUpHeader(stepUpToken) } },
              read,
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
   * Build the header that marks a write as an Ask-agent draft the user
   * reviewed and applied (design rule 6). Spread it unconditionally: without
   * `proposedByAgent` it is empty, and the write records no proposer.
   *
   * The value is the SHARED constant, never a caller-supplied string — the
   * receiving routes accept exactly that one word and 400 on anything else
   * (`proposable`), so there is no free text to get wrong or to abuse.
   */
  proposedByHeader(opts?: ProposedByOptions): Record<string, string> {
    return opts?.proposedByAgent ? { 'X-PB-Proposed-By': ASK_AGENT_PROPOSER } : {};
  }

  /**
   * An `MFA_REQUIRED` / `REAUTH_REQUIRED` refusal as a {@link MfaRequiredError},
   * announced as `mfa-required` so the layout can offer enrolment from any page.
   */
  protected mfaRequired(
    data: { code?: string; message?: string; details?: Record<string, unknown> },
    endpoint: string,
  ): MfaRequiredError {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('mfa-required', {
        detail: { code: data.code, message: data.message, endpoint },
      }));
    }
    return new MfaRequiredError(data.message || 'Two-factor authentication is required', String(data.code), data.details);
  }

  /**
   * A 429 `QUOTA_EXCEEDED` as a {@link QuotaExceededError}, announced to the
   * global notice (DashboardLayout → QuotaExceededNotice): which quota, when it
   * resets, where to raise it — on every page, whatever the caller does with the
   * error, and whichever service refused.
   */
  protected quotaExceeded(message: string, details: unknown): QuotaExceededError {
    const error = new QuotaExceededError(message, details as Record<string, unknown> | undefined);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('quota-exceeded', {
        detail: {
          message,
          quotaType: error.quotaType,
          limit: error.limit,
          used: error.used,
          resetAt: error.resetAt,
          upgradeUrl: error.upgradeUrl,
        },
      }));
    }
    return error;
  }
}
