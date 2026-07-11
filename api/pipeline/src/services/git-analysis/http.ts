// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Per-attempt timeout (ms) for external Git provider API calls. */
const EXTERNAL_HTTP_TIMEOUT_MS = 5000;
/** Number of extra attempts after the initial one (total attempts = 1 + retries). */
const EXTERNAL_HTTP_RETRIES = 2;

/**
 * `fetch` wrapper that bounds each attempt with an AbortSignal timeout and
 * retries transient failures (network errors, timeouts, and 5xx responses) up
 * to {@link EXTERNAL_HTTP_RETRIES} times. Non-5xx responses (including 4xx) are
 * returned to the caller unchanged so existing `res.ok`/status handling is
 * preserved. On exhausted retries the last error is rethrown, mirroring the
 * error shape a bare `fetch` failure would produce.
 */
export async function fetchWithTimeout(input: string, init: RequestInit = {}): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= EXTERNAL_HTTP_RETRIES; attempt++) {
    try {
      const res = await fetch(input, { ...init, signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS) });
      if (res.status >= 500 && attempt < EXTERNAL_HTTP_RETRIES) {
        lastErr = new Error(`Upstream ${res.status} ${res.statusText}`);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt >= EXTERNAL_HTTP_RETRIES) break;
    }
  }
  throw lastErr;
}
