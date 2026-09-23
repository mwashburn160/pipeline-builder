// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The API transport's own wire shapes: the session tokens a browser holds and
 *  the envelope every endpoint answers in. */

/**
 * The session tokens a browser client receives.
 *
 * There is no `refreshToken` field: for browser callers the platform returns the
 * refresh token as an HttpOnly cookie scoped to `/api/auth/refresh`, which no
 * script can read. The access token lives in memory only.
 */
export interface AuthTokens {
  accessToken: string;
  /** Access-token lifetime in seconds, when the endpoint reports it. */
  expiresIn?: number;
}

/**
 * Standard API response envelope (matches backend).
 *
 * Discriminated union on `success` so TypeScript narrows `data` to `T`
 * (not `T | undefined`) once `success === true` has been checked.
 *
 * Note: callers of `ApiClient.request()` rarely need to check `success` —
 * the client throws `ApiError` on 4xx/5xx, so success: false never
 * reaches caller code. The union is here for the few callsites that
 * inspect the raw envelope (e.g. SSE bootstrap, error inspectors).
 */
export type ApiResponse<T = unknown> =
  | {
    success: true;
    statusCode: number;
    data: T;
    message?: string;
    timestamp?: string;
  }
  | {
    success: false;
    statusCode: number;
    data?: undefined;
    message?: string;
    code?: string;
    details?: Record<string, unknown>;
    timestamp?: string;
  };
