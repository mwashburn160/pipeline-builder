// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Background flusher for compliance notification digests.
 *
 * Orgs whose `digestMode` is `daily`/`weekly` have their notifications parked as
 * pending `channel: 'digest'` log rows (see compliance-notifier). This scheduler
 * periodically aggregates each due org's pending rows into a single digest and
 * delivers it through that org's enabled channels, then stamps `lastDigestAt`.
 *
 * Modelled on scan-scheduler: a single unref'd setInterval, sysadmin tenant
 * context for the cross-org sweep, started/stopped from index.ts.
 */

import { createLogger, errorMessage, createScheduler, type Scheduler } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { dispatchImmediate } from './compliance-notifier.js';
import type { ComplianceNotification } from './notification-channels.js';
import { getLockRedis } from '../queue/compliance-event-queue.js';
import {
  getNotificationPreference,
  getOrgsWithPendingDigests,
  getPendingDigests,
  markDigestsSent,
  touchLastDigestAt,
  type ComplianceNotificationPreference,
  type PendingDigestEntry,
} from '../services/notification-service.js';

const logger = createLogger('digest-scheduler');

const complianceConfig = (Config.getAny('compliance') ?? {}) as Partial<{ digestSchedulerIntervalMs: number; digestLockTtlMs: number }>;
// Check hourly by default — fine-grained enough for daily/weekly cadences.
const SCHEDULER_INTERVAL_MS = Number(complianceConfig.digestSchedulerIntervalMs ?? 3_600_000);
// Cross-pod single-runner lock. TTL just needs to outlast one cycle's work; the
// flush is fast, so 5 min is ample and recovers quickly if a pod dies mid-run.
const LOCK_KEY = 'compliance:digest-scheduler:leader';
const LOCK_TTL_MS = Number(complianceConfig.digestLockTtlMs ?? 300_000);

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Whether an org's digest is due to flush now. */
export function isDigestDue(preference: ComplianceNotificationPreference | null, now: Date): boolean {
  // No preference, or it was switched back to immediate while rows were parked:
  // flush so the parked notifications aren't stranded.
  if (!preference || preference.digestMode === 'immediate') return true;
  const interval = preference.digestMode === 'weekly' ? WEEK_MS : DAY_MS;
  if (!preference.lastDigestAt) return true;
  return now.getTime() - new Date(preference.lastDigestAt).getTime() >= interval;
}

/** Build one digest notification from an org's parked entries. */
export function buildDigest(orgId: string, entries: PendingDigestEntry[]): ComplianceNotification {
  const items = entries.map((e) => e.notification);
  const hasHigh = items.some((n) => n.priority === 'urgent' || n.priority === 'high');
  const lines = items.map((n) => `- ${n.subject}`);
  return {
    recipientOrgId: orgId,
    messageType: 'conversation',
    priority: hasHigh ? 'high' : 'normal',
    subject: `Compliance digest: ${items.length} notification${items.length === 1 ? '' : 's'}`,
    content: `You have ${items.length} batched compliance notification${items.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}`,
    payload: {
      event: 'compliance.digest',
      orgId,
      count: items.length,
      items: items.map((n) => n.payload),
    },
  };
}

/** Flush one org's pending digest (caller ensures it's due). */
async function flushOrg(orgId: string, preference: ComplianceNotificationPreference | null, now: Date): Promise<void> {
  const entries = await getPendingDigests(orgId);
  if (entries.length === 0) return;

  await dispatchImmediate(orgId, preference, buildDigest(orgId, entries));
  await markDigestsSent(entries.map((e) => e.id));
  await touchLastDigestAt(orgId, now);

  logger.info('Compliance digest delivered', { orgId, count: entries.length });
}

/** The actual sweep — flush every org whose digest is due. */
async function sweep(): Promise<void> {
  await runWithTenantContext({ isSuperAdmin: true }, async () => {
    const now = new Date();
    const orgIds = await getOrgsWithPendingDigests();
    for (const orgId of orgIds) {
      try {
        const preference = await getNotificationPreference(orgId);
        if (!isDigestDue(preference, now)) continue;
        await flushOrg(orgId, preference, now);
      } catch (err) {
        logger.error('Digest flush failed', { orgId, error: errorMessage(err) });
      }
    }
  });
}

// Cross-pod leader lock so that with multiple compliance replicas only ONE pod
// flushes per window (others no-op).
const scheduler: Scheduler = createScheduler({
  name: 'digest-scheduler',
  intervalMs: SCHEDULER_INTERVAL_MS,
  lock: { redis: getLockRedis, key: LOCK_KEY, ttlMs: LOCK_TTL_MS },
  run: sweep,
});

/** Start the background digest scheduler. Safe to call multiple times. */
export function startDigestScheduler(): void { scheduler.start(); }

/** Stop the digest scheduler (graceful shutdown). */
export function stopDigestScheduler(): void { scheduler.stop(); }
