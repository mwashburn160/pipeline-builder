// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { safeFetch, type SafeFetchResponse } from '@pipeline-builder/api-core';

/** Per-attempt timeout (ms) for external Git provider API calls. */
const EXTERNAL_HTTP_TIMEOUT_MS = 5000;
/** Number of extra attempts after the initial one (total attempts = 1 + retries). */
const EXTERNAL_HTTP_RETRIES = 2;
/**
 * Hard cap on a Git provider response body (bytes) before we parse it. GitHub's
 * `/contents/` (and the other listing endpoints) are unpaginated, so a
 * hostile/huge repo could otherwise stream an unbounded body into the parser
 * and exhaust memory. 5 MiB comfortably covers a root listing / metadata blob.
 */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * SSRF-safe request wrapper for external Git provider APIs: retries transient
 * failures (network errors, timeouts, and 5xx responses) up to
 * {@link EXTERNAL_HTTP_RETRIES} times. Non-5xx responses (including 4xx) are
 * returned to the caller unchanged so existing `res.ok`/status handling is
 * preserved. On exhausted retries the last error is rethrown.
 *
 * Every attempt goes through api-core's {@link safeFetch}, which resolves the
 * host, PINS the vetted IP into the socket (so no DNS-rebinding window between
 * the check and the connect), refuses redirects, and enforces the per-attempt
 * timeout and the {@link MAX_RESPONSE_BYTES} body cap. A refused redirect is a
 * hard failure here — an analyzer must never read a body from an unvetted host.
 */
export async function fetchWithTimeout(
  input: string,
  init: { headers?: Record<string, string> } = {},
): Promise<SafeFetchResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= EXTERNAL_HTTP_RETRIES; attempt++) {
    let res: SafeFetchResponse;
    try {
      res = await safeFetch(input, {
        headers: init.headers,
        protocols: ['https:'],
        timeoutMs: EXTERNAL_HTTP_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });
    } catch (err) {
      lastErr = err;
      if (attempt >= EXTERNAL_HTTP_RETRIES) break;
      continue;
    }
    // Not retryable: a redirect won't resolve itself, and following it would
    // land on a host the SSRF guard never vetted.
    if (res.redirected) throw new Error(`Upstream redirected (refused): ${res.status}`);
    if (res.status >= 500 && attempt < EXTERNAL_HTTP_RETRIES) {
      lastErr = new Error(`Upstream ${res.status} ${res.statusText}`);
      continue;
    }
    return res;
  }
  throw lastErr;
}
