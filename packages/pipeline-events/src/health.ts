// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getAuthToken } from './auth.js';
import { BoundedMap, CACHE_MAX_ENTRIES, loadSdk, log } from './util.js';

// Delivery health + self-healing DLQ redrive.
// After a SUCCESSFUL batch POST we (throttled, best-effort):
//   1. POST an ingest-health signal to /api/reports/ingest-health so the Reports UI
//      can show flowing / stale / dropping.
//   2. If the DLQ is non-empty, no move task is already running, AND the oldest DLQ
//      message is younger than the poison-age ceiling, kick off an SQS
//      MessageMoveTask (DLQ → main queue) so retryable failures self-heal without a
//      new AWS service. The reporting ingest's partial-unique index dedupes any
//      redelivered event, so a redrive can't double-count.
// Guards: only on success, one-at-a-time (ListMessageMoveTasks), a poison-age ceiling
// (so a message that always fails can't loop DLQ→main→DLQ forever), and throttled via
// module timestamps. NEVER throws — a failure here must not fail the batch.
//
// IAM required (document only — granted on the events stack):
//   sqs:GetQueueAttributes, sqs:ListMessageMoveTasks, sqs:StartMessageMoveTask (on the DLQ)

interface SqsClientLike { send(command: unknown): Promise<unknown> }
interface SqsModule {
  SQSClient: new (config: { region: string }) => SqsClientLike;
  GetQueueAttributesCommand: new (input: { QueueUrl: string; AttributeNames: string[] }) => unknown;
  ListMessageMoveTasksCommand: new (input: { SourceArn: string }) => unknown;
  StartMessageMoveTaskCommand: new (input: { SourceArn: string; DestinationArn?: string }) => unknown;
}
let sqsMod: SqsModule | undefined;
let sqsClientsByRegion: Map<string, SqsClientLike> | undefined;
async function sqsClient(region: string): Promise<SqsClientLike> {
  if (!sqsMod) sqsMod = await loadSdk<SqsModule>('@aws-sdk/client-sqs');
  if (!sqsClientsByRegion) sqsClientsByRegion = new Map();
  let client = sqsClientsByRegion.get(region);
  if (!client) {
    client = new sqsMod.SQSClient({ region });
    sqsClientsByRegion.set(region, client);
  }
  return client;
}

// Delivery-health counters are attributed PER RESOLVED ORG (the forwarder is a fleet
// Lambda serving many orgs; a single global counter would mis-attribute one org's
// throughput to another). Keyed by orgId ('' bucket = pipeline with no OrgId tag).
// The DLQ depth (`dropped`) is genuinely fleet-global — one shared DLQ — so it is a
// single snapshot posted alongside each org's health, documented as the shared depth.
const forwardedByOrg = new BoundedMap<string, number>(CACHE_MAX_ENTRIES);
const lastEventAtByOrg = new BoundedMap<string, string>(CACHE_MAX_ENTRIES);
let lastHealthAt = 0;
let lastRedriveAt = 0;
const HEALTH_THROTTLE_MS = 60 * 1000;
const REDRIVE_THROTTLE_MS = 5 * 60 * 1000;
// Poison-message ceiling: if the oldest DLQ message is older than this, we STOP
// redriving it (DLQ→main→fail→DLQ would loop forever). Such messages are left for an
// alarm / manual inspection instead of churning the fleet indefinitely.
const MAX_DLQ_REDRIVE_AGE_SEC = 6 * 60 * 60; // 6 hours

/** Parse the SQS trigger ARN and derive the main + DLQ ARNs and the DLQ URL. */
function deriveQueues(mainQueueArn: string | undefined): { region: string; mainArn: string; dlqArn: string; dlqUrl: string } | undefined {
  if (!mainQueueArn) return undefined;
  // arn:aws:sqs:{region}:{account}:{name}
  const parts = mainQueueArn.split(':');
  if (parts.length < 6 || parts[2] !== 'sqs') return undefined;
  const [, , , region, account, name] = parts;
  const dlqArn = process.env.EVENT_DLQ_ARN || `arn:aws:sqs:${region}:${account}:${name}-dlq`;
  const dlqName = dlqArn.split(':').pop() ?? `${name}-dlq`;
  const dlqUrl = `https://sqs.${region}.amazonaws.com/${account}/${dlqName}`;
  return { region, mainArn: mainQueueArn, dlqArn, dlqUrl };
}

/** Snapshot the DLQ depth + the age (seconds) of its oldest message (for the
 *  poison-message redrive ceiling). Missing/NaN attributes fall back to 0. */
async function dlqStats(region: string, dlqUrl: string): Promise<{ depth: number; oldestAgeSec: number }> {
  if (!sqsMod) sqsMod = await loadSdk<SqsModule>('@aws-sdk/client-sqs');
  const client = await sqsClient(region);
  const out = await client.send(new sqsMod.GetQueueAttributesCommand({
    QueueUrl: dlqUrl,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateAgeOfOldestMessage'],
  })) as { Attributes?: { ApproximateNumberOfMessages?: string; ApproximateAgeOfOldestMessage?: string } };
  const n = Number(out.Attributes?.ApproximateNumberOfMessages ?? '0');
  const age = Number(out.Attributes?.ApproximateAgeOfOldestMessage ?? '0');
  return {
    depth: Number.isFinite(n) ? n : 0,
    oldestAgeSec: Number.isFinite(age) ? age : 0,
  };
}

async function hasActiveMoveTask(region: string, dlqArn: string): Promise<boolean> {
  if (!sqsMod) sqsMod = await loadSdk<SqsModule>('@aws-sdk/client-sqs');
  const client = await sqsClient(region);
  const out = await client.send(new sqsMod.ListMessageMoveTasksCommand({ SourceArn: dlqArn })) as {
    Results?: Array<{ Status?: string }>;
  };
  return (out.Results ?? []).some(t => t.Status === 'RUNNING');
}

async function startMoveTask(region: string, dlqArn: string, mainArn: string): Promise<void> {
  if (!sqsMod) sqsMod = await loadSdk<SqsModule>('@aws-sdk/client-sqs');
  const client = await sqsClient(region);
  await client.send(new sqsMod.StartMessageMoveTaskCommand({ SourceArn: dlqArn, DestinationArn: mainArn }));
}

/** POST one org's ingest-health signal. Returns true only on a confirmed 2xx so the
 *  caller resets that org's `forwarded` counter ONLY when the signal was accepted
 *  (a dropped/failed POST must not silently zero the accumulated count). */
async function postIngestHealth(baseUrl: string, body: { orgId?: string; forwarded: number; dropped: number; lastEventAt?: string }): Promise<boolean> {
  try {
    const token = await getAuthToken();
    const res = await fetch(`${baseUrl}/api/reports/ingest-health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn('ingest-health POST returned non-2xx (ignored)', { status: res.status, orgId: body.orgId });
      return false;
    }
    return true;
  } catch (err) {
    log.warn('ingest-health POST failed (ignored)', { error: String(err), orgId: body.orgId });
    return false;
  }
}

/**
 * Throttled, best-effort post-success work: emit per-org ingest-health and self-heal
 * the DLQ. Never throws. `forwarded`/`lastEventAt` accumulate PER ORG across batches
 * between health posts; `dropped` is the shared fleet DLQ depth snapshot. A per-org
 * counter is zeroed only after that org's health POST is confirmed 2xx.
 */
export async function reportHealthAndRedrive(baseUrl: string, mainQueueArn: string | undefined): Promise<void> {
  const now = Date.now();
  if (now - lastHealthAt < HEALTH_THROTTLE_MS) return;
  lastHealthAt = now;
  try {
    const q = deriveQueues(mainQueueArn);
    let depth = 0;
    let oldestAgeSec = 0;
    if (q) {
      try {
        const stats = await dlqStats(q.region, q.dlqUrl);
        depth = stats.depth;
        oldestAgeSec = stats.oldestAgeSec;
      } catch (err) {
        log.warn('DLQ stats check failed (ignored)', { error: (err as { name?: string })?.name ?? String(err) });
      }
    }

    // Post one health signal per resolved org, attributing its own forwarded count +
    // last event time. `dropped` (the shared fleet DLQ depth) rides along on each.
    // Snapshot the keys first so we don't mutate the map while iterating.
    const orgKeys = new Set([...forwardedByOrg.keys(), ...lastEventAtByOrg.keys()]);
    if (orgKeys.size === 0) orgKeys.add(''); // nothing forwarded yet → still report depth
    for (const key of orgKeys) {
      const forwarded = forwardedByOrg.get(key) ?? 0;
      const lastEventAt = lastEventAtByOrg.get(key);
      const ok = await postIngestHealth(baseUrl, {
        ...(key ? { orgId: key } : {}),
        forwarded,
        dropped: depth,
        lastEventAt,
      });
      // Reset the forwarded counter ONLY on a confirmed 2xx — a failed/dropped POST
      // keeps the count so the next tick re-reports it instead of losing it.
      if (ok) forwardedByOrg.set(key, 0);
    }

    if (q && depth > 0 && now - lastRedriveAt >= REDRIVE_THROTTLE_MS) {
      // Poison-message ceiling: never redrive a DLQ whose oldest message has aged
      // past the ceiling — that message keeps failing and would loop DLQ→main→DLQ.
      if (oldestAgeSec > MAX_DLQ_REDRIVE_AGE_SEC) {
        log.warn('DLQ oldest message exceeds poison-age ceiling — skipping redrive (needs manual attention)', {
          dlqArn: q.dlqArn, dropped: depth, oldestAgeSec, ceilingSec: MAX_DLQ_REDRIVE_AGE_SEC,
        });
      } else {
        try {
          if (!(await hasActiveMoveTask(q.region, q.dlqArn))) {
            lastRedriveAt = now;
            await startMoveTask(q.region, q.dlqArn, q.mainArn);
            log.info('Started self-healing DLQ→main redrive', { dlqArn: q.dlqArn, dropped: depth, oldestAgeSec });
          }
        } catch (err) {
          log.warn('DLQ redrive failed (ignored)', { error: (err as { name?: string })?.name ?? String(err) });
        }
      }
    }
  } catch (err) {
    log.warn('health/redrive step failed (ignored)', { error: String(err) });
  }
}

/** Count a forwarded batch toward each resolved org's delivery-health report. */
export function recordForwarded(events: ReadonlyArray<{ orgId: string | null; completedAt?: string; startedAt?: string }>): void {
  for (const e of events) {
    const key = e.orgId ?? '';
    forwardedByOrg.set(key, (forwardedByOrg.get(key) ?? 0) + 1);
    const at = e.completedAt || e.startedAt;
    if (at) {
      const prev = lastEventAtByOrg.get(key);
      if (!prev || at > prev) lastEventAtByOrg.set(key, at);
    }
  }
}

/** @internal Test-only: forget health counters and throttles. */
export function _resetHealthForTests(): void {
  forwardedByOrg.clear();
  lastEventAtByOrg.clear();
  lastHealthAt = 0;
  lastRedriveAt = 0;
}
