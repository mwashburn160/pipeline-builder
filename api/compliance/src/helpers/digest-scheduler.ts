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
 * Modelled on scan-scheduler: an api-core `createScheduler` loop behind a
 * leader lock, sysadmin tenant context for the cross-org sweep, started/stopped
 * from index.ts.
 */

import { createLogger, errorMessage, createScheduler, type Scheduler, leaderLockKey, DEFAULT_LEADER_LOCK_TTL_MS } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { dispatchImmediate } from './compliance-notifier.js';
import { digestIntervalMs } from './compliance-vocabulary.js';
import type { NotificationMessage } from './notification-channels.js';
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
// Cross-pod single-runner lock. The TTL is a CRASH-RECOVERY window, not a
// run-duration cover: the holder heartbeats for as long as a cycle runs.
const LOCK_KEY = leaderLockKey('compliance', 'digest-scheduler');
const LOCK_TTL_MS = Number(complianceConfig.digestLockTtlMs ?? DEFAULT_LEADER_LOCK_TTL_MS);

/** Whether an org's digest is due to flush now. */
export function isDigestDue(preference: ComplianceNotificationPreference | null, now: Date): boolean {
  // No preference, or it was switched back to immediate while rows were parked:
  // flush so the parked notifications aren't stranded.
  if (!preference || preference.digestMode === 'immediate') return true;
  const interval = digestIntervalMs(preference.digestMode);
  if (!preference.lastDigestAt) return true;
  return now.getTime() - new Date(preference.lastDigestAt).getTime() >= interval;
}

/** Build one digest notification from an org's parked entries. */
export function buildDigest(orgId: string, entries: PendingDigestEntry[]): NotificationMessage {
  const items = entries.map((e) => e.notification);
  const hasHigh = items.some((n) => n.priority === 'urgent' || n.priority === 'high');
  const lines = items.map((n) => `- ${n.subject}`);
  return {
    recipientOrgId: orgId,
    messageType: 'conversation',
    priority: hasHigh ? 'high' : 'normal',
    subject: `Compliance digest: ${items.length} notification${items.length === 1 ? '' : 's'}`,
    body: `You have ${items.length} batched compliance notification${items.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}`,
    payload: {
      event: 'compliance.digest',
      orgId,
      count: items.length,
      items: items.map((n) => n.payload),
    },
  };
}

/**
 * Most parked entries one digest message carries. A flush walks the queue in
 * pages of this size, one digest per page: loading every parked row at once
 * held them all in memory, built one unbounded message, and — past Postgres's
 * 65535 bind parameters — made `markDigestsSent`'s `IN (...)` throw AFTER the
 * delivery, so the same digest was re-sent on every sweep.
 */
export const DIGEST_PAGE_SIZE = 500;

/** Pages one flush may send; a larger backlog drains over the following sweeps. */
const MAX_DIGEST_PAGES_PER_FLUSH = 20;

/** Flush one org's pending digest (caller ensures it's due). */
export async function flushOrg(orgId: string, preference: ComplianceNotificationPreference | null, now: Date): Promise<void> {
  let sent = 0;
  let drained = false;
  for (let page = 0; page < MAX_DIGEST_PAGES_PER_FLUSH; page++) {
    const entries = await getPendingDigests(orgId, DIGEST_PAGE_SIZE);
    if (entries.length === 0) { drained = true; break; }

    // Only mark the page `sent` when EVERY enabled channel delivered it
    // (`dispatchImmediate`'s contract) — otherwise a failed webhook/email would
    // lose the batched notifications for that channel. Leave it pending to
    // retry on the next sweep.
    const delivered = await dispatchImmediate(orgId, preference, buildDigest(orgId, entries));
    if (!delivered) {
      logger.warn('Compliance digest delivery failed on at least one channel — leaving pending for retry', { orgId, count: entries.length });
      break;
    }
    await markDigestsSent(entries.map((e) => e.id));
    sent += entries.length;
    if (entries.length < DIGEST_PAGE_SIZE) { drained = true; break; }
  }
  if (sent === 0) return;
  // Only a drained queue starts the next interval; a backlog left by the page
  // cap (or a failed page) keeps flushing on the following sweeps.
  if (drained) await touchLastDigestAt(orgId, now);
  logger.info('Compliance digest delivered', { orgId, count: sent, drained });
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
// flushes per window (others no-op). Without Redis the scheduler runs lock-free
// (digest flush is idempotent per due window).
const scheduler: Scheduler = createScheduler({
  name: 'digest-scheduler',
  intervalMs: SCHEDULER_INTERVAL_MS,
  lock: { key: LOCK_KEY, ttlMs: LOCK_TTL_MS },
  run: sweep,
});

/** Start the background digest scheduler. Safe to call multiple times. */
export function startDigestScheduler(): void { scheduler.start(); }

/** Stop the digest scheduler (graceful shutdown). */
export function stopDigestScheduler(): void { scheduler.stop(); }
