// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Refund of a deleted plugin version's `plugins` quota slot (W0.5).
 *
 * Quota is a per-period FLOW, not a stock: a refund must never land in a
 * period other than the one the slot was charged to, or deleting last period's
 * uploads would mint capacity in this one. So the refund uses the SAME
 * mechanism as every other rollback — `decrementQuota` with the charge-time
 * `resetAt` snapshot (stored on the row as `quota_reset_at` at upload). The
 * quota service applies it only while that period is still current; once the
 * period has rolled over it is a no-op (the period already reset to 0).
 *
 * A row with no snapshot (system catalog loads, or a slot already refunded) is
 * not refunded. Delete clears the snapshot on the tombstone, so a later purge
 * never refunds twice.
 */

import { decrementQuota, getServiceAuthHeader, type QuotaService } from '@pipeline-builder/api-core';

/** A version row as the refund needs it (`quotaResetAt` may be a cached ISO string). */
export interface RefundableRow {
  orgId: string;
  quotaResetAt?: Date | string | null;
}

/**
 * Fire-and-forget refund of `row`'s slot, conditional on its charge period.
 * Returns whether a refund was requested.
 */
export function refundPluginSlot(quotaService: QuotaService, row: RefundableRow, logWarn: (message: string, data?: unknown) => void): boolean {
  if (!row.quotaResetAt) return false;
  const snapshot = new Date(row.quotaResetAt);
  if (Number.isNaN(snapshot.getTime())) return false;
  decrementQuota(
    quotaService, row.orgId, 'plugins',
    getServiceAuthHeader({ serviceName: 'plugin', orgId: row.orgId, role: 'member' }),
    logWarn, 1, snapshot.toISOString(),
  );
  return true;
}
