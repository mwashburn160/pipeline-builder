// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Ownership of a build job's reserved `plugins` quota slot: releasing it exactly
 * once on a terminal outcome, and re-reserving one for a fresh re-enqueue.
 *
 * A leaf module (api-core only) so the failure handler, the DLQ worker and the
 * requeue helpers share one implementation without importing each other.
 */

import { createLogger, decrementQuota, errorMessage, getServiceAuthHeader, reserveQuota } from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import type { Job } from 'bullmq';

import type { PluginBuildJobData } from '../helpers/plugin-helpers.js';

const logger = createLogger('plugin-build-queue');

/**
 * Release the org's reserved `plugins` quota slot for a build job exactly once.
 * Every terminal failure path (main worker + DLQ worker) and every DLQ purge
 * funnels through here. The `quotaReleased` flag — mutated in-memory for same-tick
 * idempotency and persisted via `updateData` so a freshly-fetched job in a later
 * purge sees it — guarantees a job that already gave its slot back on exhaustion
 * isn't decremented again when a purge removes it (double-count), while a job
 * purged before it ever reached a terminal handler still gets its slot back.
 */
export function releasePluginQuota(job: Job<PluginBuildJobData>, quotaService: QuotaService): void {
  if (job.data.quotaReleased) return;
  const { orgId, reservedResetAt } = job.data;
  // Pass the reserve-time `resetAt` snapshot so a refund on a job whose retries
  // spanned a quota-period reset is a no-op (the old period already reset to 0)
  // rather than stealing capacity from the NEW period.
  decrementQuota(quotaService, orgId, 'plugins',
    getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' }),
    logger.warn.bind(logger),
    1, reservedResetAt,
  );
  job.data.quotaReleased = true;
  void job.updateData(job.data).catch((err) =>
    logger.debug('Failed to persist quotaReleased flag', { jobId: job.id, error: String(err) }),
  );
}

/**
 * Re-reserve a `plugins` quota slot for a fresh build re-enqueue (DLQ replay or
 * failed-build retry). The source job already RELEASED its slot on terminal
 * failure, so a re-run must re-reserve one and hand ownership to the new job.
 *
 * Returns `{ quotaReleased, reservedResetAt }` for the NEW job:
 * - `quotaReleased:false` + `reservedResetAt` set when a slot was reserved (new
 *   job owns it, releases it on its own terminal, and carries the fresh
 *   period snapshot so that release is period-safe).
 * - `quotaReleased:true` (no `reservedResetAt`) when the org is at its plugin
 *   cap or the reservation call failed (the job carries no slot, keeping
 *   accounting balanced with no double-credit).
 * The re-enqueue always proceeds — it's an explicit admin action.
 */
export async function reserveReplaySlot(quotaService: QuotaService, orgId: string, authHeader: string, jobId: string): Promise<{ quotaReleased: boolean; reservedResetAt?: string }> {
  try {
    const reservation = await reserveQuota(quotaService, orgId, 'plugins', authHeader);
    if (reservation.exceeded) {
      // `unavailable` = the quota service couldn't CONFIRM (transient, not a cap);
      // log it as such so an outage isn't misread as the org being at its limit.
      // Either way the admin re-enqueue proceeds slot-less (see above).
      if (reservation.unavailable) {
        logger.warn('Re-enqueue proceeding without a plugin-quota slot (quota service unavailable)', { jobId, orgId });
      } else {
        logger.warn('Re-enqueue proceeding without a plugin-quota slot (org at cap)', { jobId, orgId });
      }
      return { quotaReleased: true };
    }
    return { quotaReleased: false, reservedResetAt: reservation.quota.resetAt };
  } catch (err) {
    logger.warn('Re-enqueue quota reservation failed; proceeding without slot', { jobId, orgId, error: errorMessage(err) });
    return { quotaReleased: true };
  }
}
