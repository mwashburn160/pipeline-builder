// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { _resetAuthForTests, getAuthToken, invalidateCredential } from './auth.js';
import { _resetHealthForTests, recordForwarded, reportHealthAndRedrive } from './health.js';
import { parseRecord, type ParsedEvent } from './parse.js';
import { _resetScmForTests } from './scm.js';
import { _resetTagsForTests } from './tags.js';
import { log } from './util.js';

/**
 * Pipeline event ingestion Lambda handler.
 *
 * Receives CodePipeline/CodeBuild events from SQS (sourced by EventBridge),
 * parses them into a normalized format, and POSTs them to the reporting service
 * via PLATFORM_BASE_URL.
 *
 * Authentication (service-account keys):
 * The Lambda holds an opaque SERVICE-ACCOUNT KEY (`pb_sa_…`), never a JWT, and
 * trades it at platform's `/auth/token/exchange` for a 5-minute token per batch.
 * It verifies NOTHING locally: an opaque key carries no claims to check, and the
 * exchange is the authority (a revoked key stops working within one token
 * lifetime, which is the entire point of the shape). The key is minted by
 * `pipeline-manager infra store-token` and rotated in place by the token-renew
 * Lambda, so the secret's value changes underneath a warm container — which is
 * why an auth failure re-reads the SECRET, not just the token.
 *
 * Environment variables:
 * - PLATFORM_BASE_URL — Base URL of the platform
 * - PLATFORM_ACCESS_KEY — the `pb_sa_…` key set directly (no Secrets Manager call), or
 * - PLATFORM_SECRET_NAME — Secrets Manager secret containing { password: <pb_sa_ key> }
 * - EVENT_DLQ_ARN — (optional) override for the dead-letter queue ARN used by the
 *   self-healing redrive; defaults to `<main-queue-arn>-dlq` derived from the SQS
 *   trigger's eventSourceARN.
 */

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const baseUrl = process.env.PLATFORM_BASE_URL;
  if (!baseUrl) throw new Error('PLATFORM_BASE_URL environment variable is required');

  // Parse + resolve all records (tag + commit lookups run concurrently). A
  // malformed record BODY is handled inside parseRecord (logged + skipped).
  //
  // PARTIAL BATCH FAILURE. A record whose resolution THROWS — AccessDenied on the
  // tag lookup, a transient SCM error — used to propagate and fail the whole
  // batch, so nine healthy events were redelivered because of one. The mapping
  // now declares `ReportBatchItemFailures`, so only the failed messageIds are
  // returned: the rest are deleted from the queue and, critically, are not held
  // past the reporting settle window waiting on a neighbour's retries.
  const settled = await Promise.all(event.Records.map(async (record) => {
    try {
      return { record, parsed: await parseRecord(record) };
    } catch (err) {
      log.warn('Record resolution failed; reporting it as a batch item failure', {
        messageId: record.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { record, failed: true as const };
    }
  }));

  const failures = settled.filter((r) => 'failed' in r).map((r) => r.record);
  const resolved = settled.filter((r): r is { record: SQSRecord; parsed: ParsedEvent | null } => !('failed' in r));
  const events = resolved.map((r) => r.parsed).filter((e): e is ParsedEvent => e !== null);

  if (events.length === 0) {
    log.info('No resolvable CodePipeline events in batch', { itemFailures: failures.length });
    return batchResponse(failures);
  }

  // POST batch to reporting service. On a 401/403 the credential this container
  // holds is stale — most often because the token-renew Lambda rotated the key in
  // Secrets Manager — so drop BOTH the cached token and the cached key, re-read,
  // and retry ONCE. `orgId` is INTERNAL (token/health keying) — strip it here so
  // it never rides the wire; the ingest resolves org from the pipeline registry,
  // not the body.
  const payloadEvents = events.map(({ orgId: _orgId, ...rest }) => rest);
  const post = (token: string) => fetch(`${baseUrl}/api/reports/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ events: payloadEvents }),
  });
  let res = await post(await getAuthToken());
  if (res.status === 401 || res.status === 403) {
    log.warn('Reporting API auth failed; re-reading the stored key and retrying once', { status: res.status });
    invalidateCredential();
    res = await post(await getAuthToken());
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    log.error(`Reporting API returned ${res.status}`, { body });
    // The POST is one call for the whole batch, so a failure here means none of
    // these events landed — every record that carried one must be retried. Records
    // that parsed to nothing (intentional skips) are NOT returned: retrying them
    // would loop until they hit the DLQ.
    return batchResponse([
      ...failures,
      ...resolved.filter((r) => r.parsed !== null).map((r) => r.record),
    ]);
  }

  // The insert already succeeded (2xx). The parsed body is only used for a log
  // line, so a non-JSON/empty body must not throw and fail the whole batch —
  // that would trigger an SQS redelivery and re-POST (duplicate) already-inserted
  // events. The ingest's partial-unique index dedupes, but avoid the churn anyway.
  const result = await res.json().catch(() => ({})) as Record<string, unknown>;
  log.info(`Ingested ${events.length} events`, { inserted: result.data });

  // Accumulate delivery-health counters PER RESOLVED ORG, then run the throttled
  // post-success health + self-healing DLQ redrive (best-effort, never fails batch).
  recordForwarded(events);
  await reportHealthAndRedrive(baseUrl, event.Records[0]?.eventSourceARN);

  return batchResponse(failures);
};

/**
 * The partial-batch response SQS expects. An EMPTY `batchItemFailures` means
 * "delete the whole batch" — which is the success case, so this is safe to return
 * unconditionally rather than only when something failed.
 */
function batchResponse(failed: SQSRecord[]): SQSBatchResponse {
  if (failed.length > 0) {
    log.warn('Returning batch item failures for redelivery', { count: failed.length });
  }
  return { batchItemFailures: failed.map((r) => ({ itemIdentifier: r.messageId })) };
}

/**
 * @internal Test-only: reset all module-level caches/throttle state so tests are
 * isolated from one another. Stripped from the published .d.ts (stripInternal).
 */
export function _resetForTests(): void {
  _resetTagsForTests();
  _resetScmForTests();
  _resetHealthForTests();
  _resetAuthForTests();
}
