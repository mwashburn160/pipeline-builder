// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { drizzleRows, type withTenantTx } from '@pipeline-builder/pipeline-data';
import { sql } from 'drizzle-orm';

const logger = createLogger('entitlement-watermark');

/** A `withTenantTx` transaction handle (kept local to avoid a service import cycle). */
type SubscriptionTx = Parameters<Parameters<typeof withTenantTx>[0]>[0];

/**
 * Per-org "last applied entitlement change" watermark for the billing →
 * compliance sync (`PUT /entitlements/:orgId`).
 *
 * Billing stamps each push with `occurredAt` (the ISO timestamp of the
 * entitlement change). Pushes can arrive OUT OF ORDER (concurrent purchase +
 * the periodic drift reconciler, retries, at-least-once delivery). Applying a
 * STALE push would revert a newer entitlement state, so the route reads the
 * watermark, skips anything not strictly newer, and records the new watermark
 * only after a successful reconcile.
 *
 * The store lives in a tiny standalone table (`compliance_entitlement_watermark`,
 * one row per org) — no RLS policy (it carries no tenant content, only sync
 * metadata) and reachable from this service alone. The table is owned by the
 * schema bootstrap (`postgres-init.sql`), NOT created here: services connect as
 * a non-superuser app role with no DDL rights on `public`, so a runtime
 * `CREATE TABLE IF NOT EXISTS` fails with "permission denied for schema public". Both methods run on the CALLER's transaction: the entitlement
 * reconcile (`subscriptionService.syncEntitledSets`) holds a per-org advisory
 * lock in a sysadmin-scoped tx and does check → apply → record inside it.
 */

/** Row shape returned by the raw watermark SELECT. */
interface WatermarkRow {
  last_occurred_at: string | Date;
}

export class EntitlementWatermarkStore {
  /**
   * The last-applied `occurredAt` for an org, or `null` if none recorded yet
   * (first push, or an org that has never synced). Runs on the caller's
   * transaction — the entitlement reconcile's sysadmin-scoped, advisory-locked tx
   * — so the check and the later {@link record} commit atomically with the apply.
   */
  async getLastOccurredAt(tx: SubscriptionTx, orgId: string): Promise<Date | null> {
    const rows = drizzleRows<WatermarkRow>((await tx.execute(sql`
      SELECT last_occurred_at
      FROM compliance_entitlement_watermark
      WHERE org_id = ${orgId}
    `)).rows);
    const raw = rows[0]?.last_occurred_at;
    return raw ? new Date(raw) : null;
  }

  /**
   * Record `occurredAt` as the org's watermark, but only if it is strictly
   * newer than what is stored (a monotonic "keep the max"), on the caller's tx.
   */
  async record(tx: SubscriptionTx, orgId: string, occurredAt: Date): Promise<void> {
    await tx.execute(sql`
      INSERT INTO compliance_entitlement_watermark (org_id, last_occurred_at)
      VALUES (${orgId}, ${occurredAt.toISOString()})
      ON CONFLICT (org_id) DO UPDATE
        SET last_occurred_at = EXCLUDED.last_occurred_at
        WHERE compliance_entitlement_watermark.last_occurred_at < EXCLUDED.last_occurred_at
    `);
    logger.debug('Recorded entitlement watermark', { orgId, occurredAt: occurredAt.toISOString() });
  }
}

export const entitlementWatermarkStore = new EntitlementWatermarkStore();
