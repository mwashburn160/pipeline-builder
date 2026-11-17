// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ComplianceScanTarget } from '@pipeline-builder/api-core';
import { schema, softDeleteRetentionMs, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, desc, eq, inArray, isNotNull, isNull, lt, type SQL } from 'drizzle-orm';
import { paginatedList } from './paginated-list.js';
import { calculateNextRun } from '../helpers/scan-scheduler.js';

/**
 * `id` + org match on a LIVE (not soft-deleted) schedule. Every read and write
 * goes through it, so a deleted schedule is invisible: list/get skip it and
 * update/toggle/delete match nothing (the routes answer 404) — it can never be
 * edited or re-activated back into firing.
 */
function liveSchedule(id: string, orgId: string): SQL | undefined {
  return and(
    eq(schema.complianceScanSchedule.id, id),
    eq(schema.complianceScanSchedule.orgId, orgId),
    isNull(schema.complianceScanSchedule.deletedAt),
  );
}

class ComplianceScanScheduleService {
  /** Paginated list of an org's live schedules. */
  async list(orgId: string, limit: number, offset: number) {
    const whereClause = and(
      eq(schema.complianceScanSchedule.orgId, orgId),
      isNull(schema.complianceScanSchedule.deletedAt),
    );

    const { rows, total } = await paginatedList(
      schema.complianceScanSchedule,
      whereClause,
      desc(schema.complianceScanSchedule.createdAt),
      limit,
      offset,
    );
    return { schedules: rows, total };
  }

  /** Create a new schedule. Caller validates the cron expression first. */
  async create(orgId: string, userId: string, target: ComplianceScanTarget, cronExpression: string) {
    const nextRunAt = calculateNextRun(cronExpression);
    const [schedule] = await withTenantTx(async (tx) => tx
      .insert(schema.complianceScanSchedule)
      .values({
        orgId,
        target,
        cronExpression,
        isActive: true,
        nextRunAt,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning());
    return schedule;
  }

  /** One schedule of the org, or null. */
  async findById(id: string, orgId: string) {
    const [row] = await withTenantTx(async (tx) => tx
      .select()
      .from(schema.complianceScanSchedule)
      .where(liveSchedule(id, orgId))
      .limit(1));
    return row ?? null;
  }

  /**
   * Update a schedule. If `cronExpression` is in the patch, caller has already
   * validated it; this method recomputes `nextRunAt` from it.
   */
  async update(
    id: string,
    orgId: string,
    userId: string,
    patch: { target?: ComplianceScanTarget; cronExpression?: string },
  ) {
    const updates: Record<string, unknown> = {
      ...patch,
      updatedBy: userId,
      updatedAt: new Date(),
    };
    if (patch.cronExpression) {
      updates.nextRunAt = calculateNextRun(patch.cronExpression);
    }

    const [updated] = await withTenantTx(async (tx) => tx
      .update(schema.complianceScanSchedule)
      .set(updates)
      .where(liveSchedule(id, orgId))
      .returning());
    return updated ?? null;
  }

  /**
   * Toggle active flag. When activating, recompute nextRunAt from the
   * stored cronExpression so it doesn't fire immediately for a long-paused
   * schedule.
   */
  async toggleActive(id: string, orgId: string, userId: string, isActive: boolean) {
    const updates: Record<string, unknown> = {
      isActive,
      updatedBy: userId,
      updatedAt: new Date(),
    };

    if (isActive) {
      const [existing] = await withTenantTx(async (tx) => tx
        .select({ cronExpression: schema.complianceScanSchedule.cronExpression })
        .from(schema.complianceScanSchedule)
        .where(liveSchedule(id, orgId)));
      if (existing) {
        updates.nextRunAt = calculateNextRun(existing.cronExpression);
      }
    }

    const [updated] = await withTenantTx(async (tx) => tx
      .update(schema.complianceScanSchedule)
      .set(updates)
      .where(liveSchedule(id, orgId))
      .returning());
    return updated ?? null;
  }

  /**
   * Soft-delete: tombstones the schedule (deletedAt/deletedBy + the shared
   * retention deadline in purgeAfter) and deactivates it. Matches only a live
   * row, so a second delete of the same id returns null (404).
   */
  async softDelete(id: string, orgId: string, userId: string) {
    const now = new Date();
    const retentionMs = softDeleteRetentionMs();
    const [deleted] = await withTenantTx(async (tx) => tx
      .update(schema.complianceScanSchedule)
      .set({
        isActive: false,
        deletedAt: now,
        deletedBy: userId,
        ...(retentionMs > 0 ? { purgeAfter: new Date(now.getTime() + retentionMs) } : {}),
        updatedBy: userId,
        updatedAt: now,
      })
      .where(liveSchedule(id, orgId))
      .returning());
    return deleted ?? null;
  }

  /**
   * Retention sweep: hard-delete up to `limit` tombstones whose purge deadline
   * has passed. Spans every org, so it MUST run in a sysadmin scope
   * (`createSoftDeletePurgeScheduler` establishes one). Returns rows purged.
   */
  async purgeExpired(now: Date, limit = 500): Promise<number> {
    return withTenantTx(async (tx) => {
      const doomed = await tx
        .select({ id: schema.complianceScanSchedule.id })
        .from(schema.complianceScanSchedule)
        .where(and(
          isNotNull(schema.complianceScanSchedule.deletedAt),
          lt(schema.complianceScanSchedule.purgeAfter, now),
        ))
        .limit(limit);
      if (doomed.length === 0) return 0;
      await tx
        .delete(schema.complianceScanSchedule)
        .where(inArray(schema.complianceScanSchedule.id, doomed.map(d => d.id)));
      return doomed.length;
    });
  }
}

export const complianceScanScheduleService = new ComplianceScanScheduleService();
