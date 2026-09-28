// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Shared plumbing for the event-ingestion Lambda modules. */

export const log = {
  info: (msg: string, data?: unknown) => console.log(JSON.stringify({ level: 'INFO', message: msg, data, ts: new Date().toISOString() })),
  warn: (msg: string, data?: unknown) => console.log(JSON.stringify({ level: 'WARN', message: msg, data, ts: new Date().toISOString() })),
  error: (msg: string, data?: unknown) => console.error(JSON.stringify({ level: 'ERROR', message: msg, data, ts: new Date().toISOString() })),
};

/**
 * A Map that holds at most `max` entries, evicting the least recently SET one.
 * Every per-key cache in this module is keyed by something unbounded (pipeline
 * ARN, pipeline × commit, org), and a fleet forwarder's warm container can live
 * for hours across thousands of pipelines — an unbounded Map is a slow leak that
 * ends in an OOM-killed Lambda and a redelivered batch.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly max: number) { super(); }
  override set(key: K, value: V): this {
    if (super.has(key)) {
      super.delete(key); // refresh recency
    } else if (this.size >= this.max) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) super.delete(oldest);
    }
    return super.set(key, value);
  }
}

/** Upper bound for every per-key cache below. */
export const CACHE_MAX_ENTRIES = 5000;

// Variable-specifier loader for SDK clients that are NOT devDependencies of this
// package (`@aws-sdk/client-codecommit`, `@aws-sdk/client-sqs` — present only in
// the Lambda runtime / jest mocks). A `string` specifier keeps `tsc` from
// resolving them at build time, and the bundle leaves `@aws-sdk/*` external.
export async function loadSdk<T>(pkg: string): Promise<T> {
  return (await import(pkg)) as T;
}

/**
 * How long one outbound call to the reporting service may take.
 *
 * A Lambda has no supervisor to notice it is stuck: an untimed `fetch` against a wedged
 * reporting service holds the invocation until the FUNCTION's own timeout, which burns
 * the whole budget, returns no batch response, and lets SQS redeliver the same records
 * to the same wedged endpoint. A bounded call fails fast, reports the batch as failed,
 * and lets the retry happen on SQS's schedule rather than by exhausting the clock.
 *
 * Default 5s, well inside a typical 30s function timeout even with one auth retry.
 */
export const FETCH_TIMEOUT_MS = Number(process.env.REPORTING_FETCH_TIMEOUT_MS ?? 5000) || 5000;

/**
 * `fetch` with a deadline.
 *
 * `AbortSignal.timeout` rather than a hand-rolled controller: it is one call, it cannot
 * leak the timer, and it rejects with a `TimeoutError` the callers already treat as a
 * failed POST. Every outbound call in this package goes through here so a new one cannot
 * be added without a deadline by simply forgetting.
 */
export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
