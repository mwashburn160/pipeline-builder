// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ApiError, StepUpRequiredError } from '../errors';
import { API_URL, isAccessTokenRefusal, isMfaErrorCode, isStepUpErrorCode, parseRetryAfterSeconds } from '../util';
import { RequestClient, stripTags } from './request';
import { CLIENT_TYPE, CLIENT_TYPE_HEADER } from './shared';

/** SSE event received from AI streaming endpoints. */
export interface StreamEvent {
  type: 'partial' | 'done' | 'error' | 'analyzing' | 'analyzed' | 'checking-plugins'
    // From-URL generation: the plugins the config references but the org lacks,
    // PROPOSED for the user to confirm — nothing is created by the stream.
    | 'missing-plugins'
    // "Ask" agent stream: grounded sources, answer tokens, tool activity, and
    // reviewable drafts (proposals) from the tool-calling agent.
    | 'sources' | 'token' | 'tool-call' | 'proposal';
  data?: unknown;
  message?: string;
  /** On an `error` event: the error code (`AI_DISABLED`, `RATE_LIMIT_EXCEEDED`, …). */
  code?: string;
  /** On an `error` event: the HTTP status the failure maps to (429, 503, 504, …). */
  status?: number;
  /** On an `error` event: the provider's own `Retry-After`, in seconds, when it sent one. */
  retryAfterSeconds?: number;
  /** On an agent `proposal` event: the single-use id the draft's outcome is reported under. */
  draftId?: string;
}

/** The streaming layer of the api client: Server-Sent Events from a POST endpoint. */
export class StreamingClient extends RequestClient {
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
        throw this.mfaRequired(data, endpoint);
      }
      // A 401 about the access token: refresh once and retry the stream
      // (mirrors request()). Any other 401 surfaces as itself.
      const tokenRefused = response.status === 401 && isAccessTokenRefusal(data.code);
      if (tokenRefused && this.canRefresh() && !endpoint.includes('/auth/refresh') && !_refreshed) {
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          yield* this.streamRequest(endpoint, body, true);
          return;
        }
        this.throwIfRefreshUnavailable();
      }
      // An expired impersonation token cannot be refreshed: end the session so
      // the app routes back to the operator's own (mirrors send()).
      if (tokenRefused && this.isImpersonating()) {
        this.notifySessionExpired();
      }
      // Every service checks apiCalls now, the streaming generators included, so a
      // refused stream raises the same global notice a refused request does.
      if (response.status === 429 && data.code === 'QUOTA_EXCEEDED') {
        throw this.quotaExceeded(stripTags(data.message) || 'Quota exceeded', data.details);
      }
      // `details` kept: a member's used-up AI share carries its used/limit/resetAt there.
      const streamError = new ApiError(stripTags(data.message) || 'Stream failed', response.status, data.code, data.details);
      // A busy AI provider answers 429/503 with its own Retry-After — kept so the
      // UI can say "retry in N s" rather than a bare failure.
      if (response.status === 429 || response.status === 503) {
        streamError.retryAfter = parseRetryAfterSeconds(response.headers.get('Retry-After'));
      }
      throw streamError;
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
