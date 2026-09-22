// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The request helper for ANONYMOUS public routes (`/api/public/*` writes: the
 * plugin-submission flow, email-confirmation links).
 *
 * Deliberately NOT the shared `api` client: that one attaches the session's
 * `Authorization` and `x-org-id` headers, and these calls must never carry an
 * identity — they act on a token from an email, even when the visitor happens
 * to be signed in. No auth header, and `credentials: 'omit'` drops cookies too.
 *
 * Every failure is an {@link ApiError} carrying the HTTP status, the server's
 * `code`, its `details`, and `retryAfter` on 429.
 */
import { ApiError } from './errors';
import { API_URL } from './util';

interface ErrorBody { message?: string; code?: string; details?: Record<string, unknown>; data?: unknown }

export async function anonymousRequest<T>(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
      credentials: 'omit',
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0, 'NETWORK_ERROR');
  }
  const body = (await response.json().catch(() => ({}))) as ErrorBody;
  if (!response.ok) {
    const error = new ApiError(body.message || `Request failed (${response.status})`, response.status, body.code, body.details);
    const retryAfter = Number(response.headers.get('Retry-After'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
    throw error;
  }
  // The platform wraps payloads as `{ success, data }`; tolerate a bare body too.
  return (body && typeof body === 'object' && 'data' in body ? body.data : body) as T;
}
