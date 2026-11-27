// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

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

/**
 * A log-safe stand-in for an ARN: `arn#<12 hex of sha256>`. Every ARN embeds the
 * AWS account id, which must never reach CloudWatch — but a stable digest still
 * lets an operator correlate log lines for the same resource (and match it by
 * hashing an ARN they already hold).
 */
export function arnRef(arn: string): string {
  return `arn#${createHash('sha256').update(arn).digest('hex').slice(0, 12)}`;
}

/**
 * Every AWS partition this package addresses, keyed by partition name: the
 * region prefix that selects it and its service-endpoint DNS suffix. ARNs embed
 * the partition, so a hard-coded `arn:aws:` names a resource that does not exist
 * in GovCloud or China (every lookup fails and the pipeline is silently skipped
 * as "untagged"); endpoints embed the suffix. One row per partition keeps the
 * two facts from drifting apart. The commercial partition has no prefix: it is
 * the fallback for any region no other row claims.
 */
export const AWS_PARTITIONS = {
  'aws': { regionPrefix: null, dnsSuffix: 'amazonaws.com' },
  'aws-cn': { regionPrefix: 'cn-', dnsSuffix: 'amazonaws.com.cn' },
  'aws-us-gov': { regionPrefix: 'us-gov-', dnsSuffix: 'amazonaws.com' },
  'aws-iso': { regionPrefix: 'us-iso-', dnsSuffix: 'c2s.ic.gov' },
  'aws-iso-b': { regionPrefix: 'us-isob-', dnsSuffix: 'sc2s.sgov.gov' },
} as const satisfies Record<string, { regionPrefix: string | null; dnsSuffix: string }>;

/** An AWS partition name (`aws`, `aws-cn`, …). */
export type AwsPartition = keyof typeof AWS_PARTITIONS;

const PARTITION_ENTRIES = Object.entries(AWS_PARTITIONS) as [AwsPartition, (typeof AWS_PARTITIONS)[AwsPartition]][];

/** The AWS partition a region belongs to; unknown prefixes fall back to `aws`. */
export function partitionForRegion(region: string | undefined): string {
  if (!region) return 'aws';
  for (const [partition, { regionPrefix }] of PARTITION_ENTRIES) {
    if (regionPrefix && region.startsWith(regionPrefix)) return partition;
  }
  return 'aws';
}

/** The service-endpoint DNS suffix for a partition (`amazonaws.com` for an unknown one). */
export function dnsSuffixForPartition(partition: string): string {
  return Object.hasOwn(AWS_PARTITIONS, partition)
    ? AWS_PARTITIONS[partition as AwsPartition].dnsSuffix
    : AWS_PARTITIONS.aws.dnsSuffix;
}

/** Upper bound for every per-key cache below. */
export const CACHE_MAX_ENTRIES = 5000;

// Variable-specifier loader for SDK clients that are NOT devDependencies of this
// package (`@aws-sdk/client-codecommit`, `@aws-sdk/client-sqs`, `@aws-sdk/client-cloudwatch` — present only in
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
 * `REPORTING_FETCH_TIMEOUT_MS` is guarded to a positive finite number: this package
 * has no api-core dependency (so no `envInt`), and `AbortSignal.timeout` THROWS
 * synchronously on a negative or infinite value — a typo like `-1` used to fail every
 * ingest call, outside the handler's `.catch`, instead of falling back to the default.
 */
export const FETCH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.REPORTING_FETCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
})();

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
