// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { assertSafeUrl } from '@pipeline-builder/api-core';

/** Per-attempt timeout (ms) for external Git provider API calls. */
const EXTERNAL_HTTP_TIMEOUT_MS = 5000;
/** Number of extra attempts after the initial one (total attempts = 1 + retries). */
const EXTERNAL_HTTP_RETRIES = 2;
/**
 * Hard cap on a Git provider response body (bytes) before we parse it. GitHub's
 * `/contents/` (and the other listing endpoints) are unpaginated, so a
 * hostile/huge repo could otherwise stream an unbounded body into `res.json()`
 * and exhaust memory. 5 MiB comfortably covers a root listing / metadata blob.
 */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * `fetch` wrapper that bounds each attempt with an AbortSignal timeout and
 * retries transient failures (network errors, timeouts, and 5xx responses) up
 * to {@link EXTERNAL_HTTP_RETRIES} times. Non-5xx responses (including 4xx) are
 * returned to the caller unchanged so existing `res.ok`/status handling is
 * preserved. On exhausted retries the last error is rethrown, mirroring the
 * error shape a bare `fetch` failure would produce.
 *
 * SSRF defense-in-depth: the target is validated with {@link assertSafeUrl}
 * (https-only, host must not resolve to a private/loopback/metadata range) and
 * redirects are refused (`redirect: 'error'`) so a 3xx can't pivot the request
 * onto an unvalidated, re-resolved host.
 */
export async function fetchWithTimeout(input: string, init: RequestInit = {}): Promise<Response> {
  await assertSafeUrl(input, { protocols: ['https:'] });

  let lastErr: unknown;
  for (let attempt = 0; attempt <= EXTERNAL_HTTP_RETRIES; attempt++) {
    try {
      const res = await fetch(input, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS),
      });
      if (res.status >= 500 && attempt < EXTERNAL_HTTP_RETRIES) {
        lastErr = new Error(`Upstream ${res.status} ${res.statusText}`);
        // Release the unread body before retrying so the failed attempt's
        // connection/stream doesn't leak.
        await res.body?.cancel().catch(() => {});
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

/**
 * Parse a JSON response body, rejecting bodies larger than {@link MAX_RESPONSE_BYTES}
 * BEFORE fully buffering/parsing them. Prefers the `Content-Length` header for an
 * early reject, then streams the body while accumulating a running byte count so an
 * absent/lying header can't smuggle an oversized payload past the cap.
 */
export async function readJsonCapped<T>(res: Response, maxBytes: number = MAX_RESPONSE_BYTES): Promise<T> {
  const declared = res.headers?.get?.('content-length');
  if (declared && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Response body exceeds ${maxBytes} bytes`);
  }

  const reader = res.body?.getReader?.();
  if (!reader) {
    // Environments without a stream body (or test doubles): fall back to text,
    // still enforcing the cap post-buffer.
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`Response body exceeds ${maxBytes} bytes`);
    }
    return JSON.parse(text) as T;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }

  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  return JSON.parse(text) as T;
}
