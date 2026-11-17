// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { correlationHeaders } from '@pipeline-builder/pipeline-core/runtime';
import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { _resetAuthForTests, getAuthToken, invalidateCredential } from './auth.js';
import { _resetHealthForTests, recordForwarded, reportHealthAndRedrive } from './health.js';
import { parseRecord, type ParsedEvent } from './parse.js';
import { _resetScmForTests } from './scm.js';
import { _resetTagsForTests } from './tags.js';
import { fetchWithTimeout, log } from './util.js';

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

export const handler = async (event: SQSEvent, context?: Pick<Context, 'awsRequestId'>): Promise<SQSBatchResponse> => {
  const baseUrl = process.env.PLATFORM_BASE_URL;
  if (!baseUrl) throw new Error('PLATFORM_BASE_URL environment variable is required');

  // One request id for the whole batch — the Lambda's awsRequestId (so the
  // reporting audit row joins this invocation's CloudWatch log), else a uuid.
  // Sent as X-Request-Id on the ingest POST and the ingest-health POST.
  const requestId = context?.awsRequestId || randomUUID();

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
  const carried = resolved.filter((r): r is { record: SQSRecord; parsed: ParsedEvent } => r.parsed !== null);
  const send = async (batch: readonly ParsedEvent[]): Promise<Response> => {
    const body = JSON.stringify({ events: batch.map(({ orgId: _orgId, ...rest }) => rest) });
    const post = (token: string) => fetchWithTimeout(`${baseUrl}/api/reports/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...correlationHeaders({ requestId }) },
      body,
    }).catch((err: unknown) => { throw new IngestUnreachableError(err); });
    let res = await post(await getAuthToken());
    if (res.status === 401 || res.status === 403) {
      log.warn('Reporting API auth failed; re-reading the stored key and retrying once', { status: res.status });
      invalidateCredential();
      res = await post(await getAuthToken());
    }
    return res;
  };

  let res: Response;
  try {
    res = await send(events);
  } catch (err) {
    // The ingest POST itself failed (unreachable, timed out): as transient as a
    // 5xx, and handled the same way — the records that carried an event retry,
    // the intentional skips do not. Throwing would redeliver the WHOLE batch,
    // skips included, until they reached the DLQ. A credential failure is NOT
    // this: it still fails the invocation (fail closed, visible as an error).
    if (!(err instanceof IngestUnreachableError)) throw err;
    log.error('Reporting API call failed', { error: err.message });
    return batchResponse([...failures, ...carried.map((r) => r.record)]);
  }
  let delivered: ParsedEvent[] = events;

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (!isRefusal(res.status)) {
      log.error(`Reporting API returned ${res.status}`, { body });
      // A transient failure (5xx, throttling, an auth failure that survived the
      // re-read) means none of these events landed — every record that carried
      // one must be retried. Records that parsed to nothing (intentional skips)
      // are NOT returned: retrying them would loop until they hit the DLQ.
      return batchResponse([...failures, ...carried.map((r) => r.record)]);
    }
    // The ingest REFUSED the batch (validation, too large). That is about the
    // events, not the moment, so retrying the batch would fail the same way —
    // one oversized event used to hold every neighbour in the queue until the
    // whole batch reached the DLQ. Send each event on its own: the good ones
    // land, a refused one is dropped (logged), a transient failure retries.
    delivered = [];
    if (carried.length === 1) {
      logRefused(carried[0]!, res.status, body);
    } else {
      log.warn('Reporting API refused the batch; delivering its events one at a time', { status: res.status, count: carried.length });
      const outcomes = await Promise.all(carried.map(async (pair) => {
        try {
          const one = await send([pair.parsed]);
          if (one.ok) return 'delivered' as const;
          const oneBody = await one.text().catch(() => '');
          if (isRefusal(one.status)) {
            logRefused(pair, one.status, oneBody);
            return 'refused' as const;
          }
          log.error(`Reporting API returned ${one.status} for one event`, { messageId: pair.record.messageId, body: oneBody });
        } catch (err) {
          log.error('Reporting API call failed for one event', { messageId: pair.record.messageId, error: err instanceof Error ? err.message : String(err) });
        }
        return 'retry' as const;
      }));
      carried.forEach((pair, i) => {
        if (outcomes[i] === 'delivered') delivered.push(pair.parsed);
        else if (outcomes[i] === 'retry') failures.push(pair.record);
      });
    }
    if (delivered.length === 0) return batchResponse(failures);
    log.info(`Ingested ${delivered.length} of ${carried.length} events one at a time`);
  } else {
    // The insert already succeeded (2xx). The parsed body is only used for a log
    // line, so a non-JSON/empty body must not throw and fail the whole batch —
    // that would trigger an SQS redelivery and re-POST (duplicate) already-inserted
    // events. The ingest's partial-unique index dedupes, but avoid the churn anyway.
    const result = await res.json().catch(() => ({})) as Record<string, unknown>;
    log.info(`Ingested ${events.length} events`, { inserted: result.data });
  }

  // Accumulate delivery-health counters PER RESOLVED ORG, then run the throttled
  // post-success health + self-healing DLQ redrive (best-effort, never fails batch).
  recordForwarded(delivered);
  await reportHealthAndRedrive(baseUrl, event.Records[0]?.eventSourceARN, requestId);

  return batchResponse(failures);
};

/** The ingest POST threw (network failure, timeout) — never an auth or exchange failure. */
class IngestUnreachableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'IngestUnreachableError';
  }
}

/**
 * Whether the ingest refused the request's CONTENT (validation, payload too
 * large) rather than failing for the moment: resending the same events fails
 * the same way, so they are delivered one by one and a refused one is dropped.
 */
function isRefusal(status: number): boolean {
  return status === 400 || status === 413 || status === 422;
}

/**
 * Drop one event the ingest refused on its own. Not returned for redelivery —
 * it would be refused again on every attempt. Logged as an error with a stable
 * message (`Reporting ingest refused an event`) so a log metric filter can count
 * and alarm on it.
 */
function logRefused(pair: { record: SQSRecord; parsed: ParsedEvent }, status: number, body: string): void {
  log.error('Reporting ingest refused an event; dropping it', {
    messageId: pair.record.messageId,
    status,
    body: body.slice(0, 1000),
    pipelineId: pair.parsed.pipelineId,
    eventType: pair.parsed.eventType,
    executionId: pair.parsed.executionId,
  });
}

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
