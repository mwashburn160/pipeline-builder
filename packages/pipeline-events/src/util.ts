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
