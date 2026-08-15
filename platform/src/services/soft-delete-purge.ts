// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Retention purge for platform-owned soft-deleted tables (dashboards + alert
 * destinations/rules). These services are hand-rolled drizzle (not CrudService),
 * so they can't ride the api services' `CrudService.purgeExpired`; this module
 * provides an equivalent, wired through the SAME leader-locked, sysadmin-scoped
 * `createSoftDeletePurgeScheduler` the api services use.
 *
 * Their `delete()` stamps `purge_after` (see each service); this sweep hard-
 * deletes tombstones once it has passed. `dashboard_panels` rows cascade via ON
 * DELETE CASCADE, so no dependent teardown is needed. Opt out with
 * SOFT_DELETE_PURGE_ENABLED=false.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { schema, withTenantTx, createSoftDeletePurgeScheduler, type PurgeableEntity } from '@pipeline-builder/pipeline-data';
import { and, inArray, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

const logger = createLogger('platform-soft-delete-purge');

/** Hard-delete up to `limit` expired tombstones from one table
 *  (`deletedAt IS NOT NULL AND purge_after < now`). Mirrors
 *  CrudService.purgeExpired. Runs in the caller's tenant scope — the scheduler's
 *  `runSoftDeletePurge` establishes a sysadmin scope so it spans all orgs. */
async function purgeExpiredTombstones(
  table: PgTable,
  cols: { id: AnyColumn; deletedAt: AnyColumn; purgeAfter: AnyColumn },
  now: Date,
  limit: number,
): Promise<number> {
  return withTenantTx(async (tx) => {
    const doomed = await tx
      .select({ id: cols.id as never })
      .from(table)
      .where(and(sql`${cols.deletedAt} IS NOT NULL`, sql`${cols.purgeAfter} < ${now}`))
      .limit(limit)
      .then((r) => (r as Array<{ id: unknown }>).map((d) => String(d.id)));
    if (doomed.length === 0) return 0;
    await tx.delete(table).where(inArray(cols.id, doomed));
    return doomed.length;
  });
}

const ENTITIES: PurgeableEntity[] = [
  {
    name: 'dashboard',
    purgeExpired: (now, limit = 500) => purgeExpiredTombstones(
      schema.dashboard,
      { id: schema.dashboard.id, deletedAt: schema.dashboard.deletedAt, purgeAfter: schema.dashboard.purgeAfter },
      now, limit,
    ),
  },
  {
    name: 'org_alert_destination',
    purgeExpired: (now, limit = 500) => purgeExpiredTombstones(
      schema.orgAlertDestination,
      { id: schema.orgAlertDestination.id, deletedAt: schema.orgAlertDestination.deletedAt, purgeAfter: schema.orgAlertDestination.purgeAfter },
      now, limit,
    ),
  },
  {
    name: 'org_alert_rule',
    purgeExpired: (now, limit = 500) => purgeExpiredTombstones(
      schema.orgAlertRule,
      { id: schema.orgAlertRule.id, deletedAt: schema.orgAlertRule.deletedAt, purgeAfter: schema.orgAlertRule.purgeAfter },
      now, limit,
    ),
  },
];

let scheduler: ReturnType<typeof createSoftDeletePurgeScheduler> = null;

/** Start the platform retention purge (idempotent). No-op when disabled. */
export function startSoftDeletePurge(): void {
  if (scheduler) return;
  scheduler = createSoftDeletePurgeScheduler({ service: 'platform', entities: ENTITIES });
  if (scheduler) {
    scheduler.start();
    logger.info('Platform soft-delete purge sweep started');
  }
}

/** Stop the sweep (clean shutdown). */
export function stopSoftDeletePurge(): void {
  scheduler?.stop();
  scheduler = null;
}
