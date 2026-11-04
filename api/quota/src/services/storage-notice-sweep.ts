// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The 80% / 100% notices for `storageBytes`.
 *
 * Every other quota notifies from its INCREMENT: the write that crosses 80%
 * calls `notifyThresholds` on its way through. Storage has no increment — the
 * registry measures a namespace live and gates its own pushes — so that one
 * path never fired for it, and the result was that **no proactive storage
 * notice was ever sent, on any tier**. An organization's first news of a full
 * registry was a bare 403 on `docker push`.
 *
 * This sweep supplies the missing half: it READS each org's measured usage and
 * calls the same notifier, so storage rides the inbox + email + webhook
 * delivery, the dedupe, the metrics and the opt-out that already exist. Nothing
 * about the delivery is new; only the trigger.
 *
 * THE DEDUPE IS THE DESIGN PROBLEM, because the notifier dedupes per PERIOD and
 * a stock has none. A flow crosses 80% and resets; storage crosses 80% and
 * stays there for months. Keying on a period would either notify once and never
 * again — so an account that sat at 85% and then filled up would get no 100%
 * notice — or notify every single sweep. So the key is a REMINDER WINDOW
 * (`QUOTA_STORAGE_NOTICE_REMINDER_DAYS`, 7 by default):
 *
 *  - within one window, each band notifies at most once, and climbing from 85%
 *    to full still sends the 100% notice because that threshold is unclaimed;
 *  - a new window re-reminds, so a persistently full account is not told once
 *    and then forgotten;
 *  - dropping back below a band CLEARS that account's claims, so freeing space
 *    and filling up again notifies promptly rather than waiting for the window.
 */

import {
  createLogger,
  createScheduler,
  DEFAULT_LEADER_LOCK_TTL_MS,
  emitCounter,
  envBool,
  envInt,
  errorMessage,
  leaderLockKey,
  type Scheduler,
} from '@pipeline-builder/api-core';
import { setGauge } from '@pipeline-builder/api-server';
import { config } from '../config.js';
import { fetchStorageBytes } from './storage-usage.js';
import { notifyThresholds } from './threshold-notifier.js';
import { expandOrgScope } from '../helpers/org-hierarchy.js';
import { defaultLimitFor } from '../helpers/quota-helpers.js';
import { Organization } from '../models/organization.js';
import { QuotaNotice, QUOTA_NOTICE_THRESHOLDS, type QuotaNoticeThreshold } from '../models/quota-notice.js';

const logger = createLogger('storage-notice-sweep');

const SWEEP_METRIC = 'quota_storage_sweep_orgs_total';

/**
 * Storage the platform has SOLD: the sum of every account root's effective
 * `storageBytes` cap (tier baseline plus any Storage Packs and operator
 * overrides). Paired with the physical capacity behind the registry's blobs,
 * this is what says whether the platform can still honour what it has promised.
 *
 * Oversubscription is normal and healthy — nobody uses their whole cap, so a
 * ratio above 1 is thin provisioning working as intended. The number matters
 * because the failure it predicts is the worst one available: a full volume
 * stops EVERY tenant at once, and no tenant did anything wrong. Every other
 * storage signal fires when the disk is already filling; this one fires months
 * earlier and its remedy is commercial (grow ahead of demand, or stop selling
 * into that volume) rather than operational.
 */
const COMMITTED_GAUGE = 'quota_storage_committed_bytes';

/**
 * Account roots whose storage is UNLIMITED (-1) and therefore absent from
 * {@link COMMITTED_GAUGE}.
 *
 * Reported separately rather than folded in, because an unlimited org makes the
 * commitment unmeasurable rather than large — and because a billing-disabled
 * deployment puts EVERY org on the `unlimited` tier, where the committed figure
 * is meaningless by design and not a problem to alert on. An alert reading the
 * committed gauge has to be able to see that.
 */
const UNLIMITED_GAUGE = 'quota_storage_unlimited_orgs';

/** The highest band `used/limit` has reached, or `null` when under them all. */
export function storageBand(used: number, limit: number): QuotaNoticeThreshold | null {
  if (limit <= 0) return null;
  const crossed = QUOTA_NOTICE_THRESHOLDS.filter((t) => used * 100 >= t * limit);
  return crossed.length > 0 ? crossed[crossed.length - 1]! : null;
}

/**
 * The dedupe key a stock's notices are claimed under: the reminder window, not
 * a period. Passed as the notifier's `resetAt`, which is what identifies a
 * claim — see this module's header for why a period cannot be used.
 */
export function stockNoticeWindow(reminderMs: number, now: number = Date.now()): string {
  return `stock-window:${Math.floor(now / reminderMs)}`;
}

/**
 * Report how much storage the platform has committed to, across EVERY account
 * root.
 *
 * Deliberately NOT folded into the notice sweep's loop, even though that loop
 * already has each root's limit in hand: the sweep is bounded by
 * `QUOTA_STORAGE_SWEEP_MAX_ORGS` so it stays a slow background job, and a
 * commitment total summed over a bounded slice would UNDER-state the figure —
 * an alert built on it would then never fire, which is worse than no alert.
 *
 * It needs no registry read at all (a cap is a number the quota service already
 * owns), so it is one grouped aggregation over the whole fleet: cheap, exact,
 * and independent of the sweep's bound. Grouping by (tier, stored cap) keeps it
 * O(distinct tiers) rows rather than O(orgs), and the tier default is applied in
 * JS because that is where the override precedence lives.
 */
export async function reportStorageCommitment(): Promise<{ committedBytes: number; unlimitedOrgs: number }> {
  const buckets = await Organization.aggregate<{ _id: { tier?: string; cap?: number }; n: number }>([
    { $match: { parentOrgId: null } },
    { $group: { _id: { tier: '$tier', cap: '$quotas.storageBytes' }, n: { $sum: 1 } } },
  ]);
  let committedBytes = 0;
  let unlimitedOrgs = 0;
  for (const b of buckets) {
    // Same precedence as every read path: an explicit per-org cap wins, else the
    // tier's default.
    const limit = b._id.cap ?? defaultLimitFor(b._id.tier, 'storageBytes');
    if (limit < 0) unlimitedOrgs += b.n;
    // A deliberate 0 ("none") commits nothing.
    else if (limit > 0) committedBytes += limit * b.n;
  }
  setGauge(COMMITTED_GAUGE, {}, committedBytes);
  setGauge(UNLIMITED_GAUGE, {}, unlimitedOrgs);
  return { committedBytes, unlimitedOrgs };
}

export interface StorageSweepResult {
  /** Orgs with a finite storage limit that the pass looked at. */
  considered: number;
  /** Orgs whose usage could not be read — never notified, by design. */
  unknown: number;
  /** Orgs at or above a band, for which a notice was attempted. */
  notified: number;
  /** Orgs that had dropped below every band, whose claims were cleared. */
  cleared: number;
}

interface SweepOptions {
  /** Cap on orgs examined in one pass, so this stays a slow background job. */
  maxOrgs: number;
  reminderMs: number;
  /** Abort between orgs when the leader lock is lost or we are shutting down. */
  shouldStop?: () => boolean;
}

/**
 * One pass. Exported for the tests and for a manual run; the scheduler below is
 * what drives it in a deployment.
 */
export async function sweepStorageNotices(opts: SweepOptions): Promise<StorageSweepResult> {
  const result: StorageSweepResult = { considered: 0, unknown: 0, notified: 0, cleared: 0 };
  const windowKey = stockNoticeWindow(opts.reminderMs);

  // ACCOUNT ROOTS only (`parentOrgId: null`). A team's own limits are -1 by
  // design — the caps are pooled at its root — so a team has no percentage of
  // its own to cross, and the notice goes to the root in any case.
  //
  // The query must NOT filter on `quotas.storageBytes` existing: an org that
  // never had an operator override has no such field and takes its limit from
  // the tier default, which is most of the fleet. A first draft of this query
  // required the field and would therefore have swept almost nobody — the exact
  // silent-no-op this whole plan exists to remove.
  const orgs = await Organization.find(
    { parentOrgId: null },
    { '_id': 1, 'tier': 1, 'quotas.storageBytes': 1 },
  ).limit(opts.maxOrgs).lean();

  for (const org of orgs) {
    if (opts.shouldStop?.()) break;
    const orgId = String(org._id);
    const row = org as { tier?: string; quotas?: { storageBytes?: number } };
    // Same resolution the read path uses: an explicit per-org cap, else the
    // tier's default. Unlimited (-1) and a deliberate 0 both have no band.
    const limit = row.quotas?.storageBytes ?? defaultLimitFor(row.tier, 'storageBytes');
    if (typeof limit !== 'number' || limit <= 0) continue;
    result.considered += 1;

    try {
      // The ACCOUNT's total, not one namespace: the limit is pooled at the root
      // and the dashboard already reports the whole subtree's storage against
      // it, so a notice measured on one namespace would disagree with the figure
      // the recipient is looking at. `fetchStorageBytes` sums what it can and
      // answers null only when NOTHING could be measured.
      const scope = await expandOrgScope(orgId);
      const used = await fetchStorageBytes(scope);
      // NEVER notify on an unknown reading. `null` means the registry was
      // unreachable or answered malformed — not 0 and not full. Treating it as
      // either would mail the whole customer base during a registry outage.
      if (used === null) {
        result.unknown += 1;
        emitCounter(SWEEP_METRIC, { outcome: 'unknown' });
        continue;
      }

      // `orgId` IS the account root — the query selected roots only.
      const rootOrgId = orgId;
      const band = storageBand(used, limit);

      if (band === null) {
        // Under every band: drop this account's claims so a later crossing
        // notifies at once instead of waiting out the reminder window.
        const { deletedCount } = await QuotaNotice.deleteMany({ rootOrgId, quotaType: 'storageBytes' });
        if (deletedCount > 0) {
          result.cleared += 1;
          emitCounter(SWEEP_METRIC, { outcome: 'cleared' });
        }
        continue;
      }

      // Claims above the CURRENT band go too: an account that fell from full
      // back to 85% should hear about 100% again if it refills, and should not
      // be re-told "80%" in the meantime (that threshold stays claimed).
      await QuotaNotice.deleteMany({ rootOrgId, quotaType: 'storageBytes', threshold: { $gt: band } });

      await notifyThresholds({
        rootOrgId,
        quotaType: 'storageBytes',
        limit,
        used,
        // Zero: nothing was written: this is a MEASUREMENT, so every band at or
        // below the reading is reported rather than only one freshly crossed.
        amount: 0,
        resetAt: windowKey,
        source: 'sweep',
      });
      result.notified += 1;
      emitCounter(SWEEP_METRIC, { outcome: 'notified' });
    } catch (err) {
      // One org's failure must not end the pass.
      emitCounter(SWEEP_METRIC, { outcome: 'failed' });
      logger.warn('Storage notice check failed for an org', { orgId, error: errorMessage(err) });
    }
  }
  return result;
}

let scheduler: Scheduler | null = null;

function createStorageNoticeScheduler(): Scheduler | null {
  if (!config.quota.thresholdNoticesEnabled) {
    logger.info('Storage notice sweep skipped: threshold notices are disabled');
    return null;
  }
  if (!envBool('QUOTA_STORAGE_SWEEP_ENABLED', true)) {
    logger.info('Storage notice sweep skipped: QUOTA_STORAGE_SWEEP_ENABLED=false');
    return null;
  }

  // Hours, not minutes. Each org costs one registry read (cached per org for
  // QUOTA_STORAGE_USAGE_CACHE_TTL_MS), and storage moves slowly — nobody fills a
  // registry between two sweeps without a build, which the push gate already
  // governs.
  const intervalMs = envInt('QUOTA_STORAGE_SWEEP_INTERVAL_HOURS', 6, { min: 1 }) * 60 * 60 * 1000;
  const startupDelayMs = envInt('QUOTA_STORAGE_SWEEP_STARTUP_DELAY_MS', 120_000, { min: 0 });
  // A CRASH-RECOVERY window, not a run-duration cover: withLeaderLock
  // heartbeats for as long as the pass runs.
  const lockTtlMs = envInt('QUOTA_STORAGE_SWEEP_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1000 });
  const maxOrgs = envInt('QUOTA_STORAGE_SWEEP_MAX_ORGS', 200, { min: 1 });
  const reminderMs = envInt('QUOTA_STORAGE_NOTICE_REMINDER_DAYS', 7, { min: 1 }) * 86_400_000;

  logger.info('Storage notice sweep starting', { intervalHours: intervalMs / 3_600_000, maxOrgs });

  return createScheduler({
    name: 'quota-storage-notices',
    intervalMs,
    startupDelayMs,
    run: async (run) => {
      try {
        // Before the bounded per-org pass, and independent of it: the fleet-wide
        // commitment total, which an alert compares against the physical
        // capacity behind the registry's blobs.
        const commitment = await reportStorageCommitment();
        const result = await sweepStorageNotices({
          maxOrgs,
          reminderMs,
          shouldStop: () => run.signal.aborted,
        });
        logger.info('Storage notice sweep finished', { ...result, ...commitment });
      } catch (err) {
        logger.error('Storage notice sweep failed', { error: errorMessage(err) });
      }
    },
    lock: { key: leaderLockKey('quota', 'storage-notices'), ttlMs: lockTtlMs },
  });
}

/** Start the storage notice sweep (idempotent). No-op when disabled. */
export function startStorageNoticeSweep(): void {
  if (scheduler) return;
  scheduler = createStorageNoticeScheduler();
  if (scheduler) {
    scheduler.start();
    logger.info('Storage notice sweep started');
  }
}

/** Stop the sweep (clean shutdown). */
export function stopStorageNoticeSweep(): void {
  scheduler?.stop();
  scheduler = null;
}
