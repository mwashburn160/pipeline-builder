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

import { SYSTEM_ACTOR_ID, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { schema, withTenantTx, createSoftDeletePurgeScheduler, type PurgeableEntity } from '@pipeline-builder/pipeline-data';
import { and, inArray, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { CustomSweepDefinition } from './background-sweeps.js';
import { recordAuditEvent } from '../helpers/audit.js';
import type { AuditAction } from '../models/audit-event.js';

/** Hard-delete up to `limit` expired tombstones from one table
 *  (`deletedAt IS NOT NULL AND purge_after < now`). Mirrors
 *  CrudService.purgeExpired. Runs in the caller's tenant scope — the scheduler's
 *  `runSoftDeletePurge` establishes a sysadmin scope so it spans all orgs.
 *
 *  Each hard delete is audited (`audited.action`, system actor) by id against its org,
 *  AFTER the transaction commits — the retention purge is the one deletion no
 *  person performs, so without this the row simply stops existing. */
async function purgeExpiredTombstones(
  table: PgTable,
  cols: { id: AnyColumn; orgId: AnyColumn; deletedAt: AnyColumn; purgeAfter: AnyColumn },
  audited: { action: AuditAction; targetType: string },
  now: Date,
  limit: number,
): Promise<number> {
  const doomed = await withTenantTx(async (tx) => {
    const rows = await tx
      .select({ id: cols.id as never, orgId: cols.orgId as never })
      .from(table)
      .where(and(sql`${cols.deletedAt} IS NOT NULL`, sql`${cols.purgeAfter} < ${now}`))
      .limit(limit)
      .then((r) => (r as Array<{ id: unknown; orgId?: unknown }>).map((d) => ({ id: String(d.id), orgId: d.orgId == null ? undefined : String(d.orgId) })));
    if (rows.length === 0) return rows;
    await tx.delete(table).where(inArray(cols.id, rows.map((d) => d.id)));
    return rows;
  });
  for (const row of doomed) {
    recordAuditEvent({
      action: audited.action,
      actorId: SYSTEM_ACTOR_ID,
      orgId: SYSTEM_ORG_ID,
      ...(row.orgId ? { affectedOrgId: row.orgId } : {}),
      targetType: audited.targetType,
      targetId: row.id,
      outcome: 'success',
      details: { reason: 'retention-purge' },
    });
  }
  return doomed.length;
}

const ENTITIES: PurgeableEntity[] = [
  {
    name: 'dashboard',
    purgeExpired: (now, limit = 500) => purgeExpiredTombstones(
      schema.dashboard,
      { id: schema.dashboard.id, orgId: schema.dashboard.orgId, deletedAt: schema.dashboard.deletedAt, purgeAfter: schema.dashboard.purgeAfter },
      { action: 'dashboard.purge', targetType: 'dashboard' }, now, limit,
    ),
  },
  {
    name: 'org_alert_destination',
    purgeExpired: (now, limit = 500) => purgeExpiredTombstones(
      schema.orgAlertDestination,
      { id: schema.orgAlertDestination.id, orgId: schema.orgAlertDestination.orgId, deletedAt: schema.orgAlertDestination.deletedAt, purgeAfter: schema.orgAlertDestination.purgeAfter },
      { action: 'alert.destination.purge', targetType: 'alert-destination' }, now, limit,
    ),
  },
  {
    name: 'org_alert_rule',
    purgeExpired: (now, limit = 500) => purgeExpiredTombstones(
      schema.orgAlertRule,
      { id: schema.orgAlertRule.id, orgId: schema.orgAlertRule.orgId, deletedAt: schema.orgAlertRule.deletedAt, purgeAfter: schema.orgAlertRule.purgeAfter },
      { action: 'alert.rule.purge', targetType: 'alert-rule' }, now, limit,
    ),
  },
];

/** The retention purge as a background sweep; disabled (no scheduler) when
 *  SOFT_DELETE_PURGE_ENABLED=false. Leader-locked inside the shared scheduler. */
export const softDeletePurgeSweep: CustomSweepDefinition = {
  name: 'soft-delete-purge',
  create: () => createSoftDeletePurgeScheduler({ service: 'platform', entities: ENTITIES }),
};
