// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { drizzleRows, runWithTenantContext, withTenantTx } from '@pipeline-builder/pipeline-data';
import { sql } from 'drizzle-orm';

const logger = createLogger('entitlement-watermark');

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
 * one row per org) created lazily with `CREATE TABLE IF NOT EXISTS` — no RLS
 * policy (it carries no tenant content, only sync metadata) and reachable from
 * this service alone. All access runs under a sysadmin tenant scope because the
 * entitlement-sync route has no org context (`:orgId` is the target root org,
 * not the token's org).
 */

/** Row shape returned by the raw watermark SELECT. */
interface WatermarkRow {
  last_occurred_at: string | Date;
}

/** Ensure the watermark table exists. Idempotent; cheap after first call. */
let ensured = false;
async function ensureTable(tx: Parameters<Parameters<typeof withTenantTx>[0]>[0]): Promise<void> {
  if (ensured) return;
  await tx.execute(sql`
    CREATE TABLE IF NOT EXISTS compliance_entitlement_watermark (
      org_id text PRIMARY KEY,
      last_occurred_at timestamptz NOT NULL
    )
  `);
  ensured = true;
}

export class EntitlementWatermarkStore {
  /**
   * The last-applied `occurredAt` for an org, or `null` if none recorded yet
   * (first push, or an org that has never synced).
   */
  async getLastOccurredAt(orgId: string): Promise<Date | null> {
    return runWithTenantContext({ isSuperAdmin: true }, () =>
      withTenantTx(async (tx) => {
        await ensureTable(tx);
        const rows = drizzleRows<WatermarkRow>((await tx.execute(sql`
          SELECT last_occurred_at
          FROM compliance_entitlement_watermark
          WHERE org_id = ${orgId}
        `)).rows);
        const raw = rows[0]?.last_occurred_at;
        return raw ? new Date(raw) : null;
      }));
  }

  /**
   * Record `occurredAt` as the org's watermark, but only if it is strictly
   * newer than what is stored (a monotonic "keep the max"). Safe to call after
   * a successful reconcile even under a concurrent newer push — the conditional
   * `ON CONFLICT ... WHERE` never regresses the watermark.
   */
  async record(orgId: string, occurredAt: Date): Promise<void> {
    await runWithTenantContext({ isSuperAdmin: true }, () =>
      withTenantTx(async (tx) => {
        await ensureTable(tx);
        await tx.execute(sql`
          INSERT INTO compliance_entitlement_watermark (org_id, last_occurred_at)
          VALUES (${orgId}, ${occurredAt.toISOString()})
          ON CONFLICT (org_id) DO UPDATE
            SET last_occurred_at = EXCLUDED.last_occurred_at
            WHERE compliance_entitlement_watermark.last_occurred_at < EXCLUDED.last_occurred_at
        `);
      }));
    logger.debug('Recorded entitlement watermark', { orgId, occurredAt: occurredAt.toISOString() });
  }
}

export const entitlementWatermarkStore = new EntitlementWatermarkStore();
