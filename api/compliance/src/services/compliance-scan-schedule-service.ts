// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  db,
  drizzleCount,
  schema,
} from '@pipeline-builder/pipeline-core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { calculateNextRun } from '../helpers/scan-scheduler';

export type ScanTarget = 'plugin' | 'pipeline' | 'all';

class ComplianceScanScheduleService {
  /** Paginated list of schedules for an org. */
  async list(orgId: string, limit: number, offset: number) {
    const whereClause = eq(schema.complianceScanSchedule.orgId, orgId);

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.complianceScanSchedule)
      .where(whereClause)
      .then(r => drizzleCount(r));

    const schedules = await db
      .select()
      .from(schema.complianceScanSchedule)
      .where(whereClause)
      .orderBy(desc(schema.complianceScanSchedule.createdAt))
      .limit(limit)
      .offset(offset);

    return { schedules, total: countResult?.count ?? 0 };
  }

  /** Create a new schedule. Caller validates the cron expression first. */
  async create(orgId: string, userId: string, target: ScanTarget, cronExpression: string) {
    const nextRunAt = calculateNextRun(cronExpression);
    const [schedule] = await db
      .insert(schema.complianceScanSchedule)
      .values({
        orgId, target, cronExpression,
        isActive: true, nextRunAt,
        createdBy: userId, updatedBy: userId,
      })
      .returning();
    return schedule;
  }

  /**
   * Update a schedule. If `cronExpression` is in the patch, caller has already
   * validated it; this method recomputes `nextRunAt` from it.
   */
  async update(
    id: string,
    orgId: string,
    userId: string,
    patch: { target?: ScanTarget; cronExpression?: string },
  ) {
    const updates: Record<string, unknown> = {
      ...patch,
      updatedBy: userId,
      updatedAt: new Date(),
    };
    if (patch.cronExpression) {
      updates.nextRunAt = calculateNextRun(patch.cronExpression);
    }

    const [updated] = await db
      .update(schema.complianceScanSchedule)
      .set(updates)
      .where(and(
        eq(schema.complianceScanSchedule.id, id),
        eq(schema.complianceScanSchedule.orgId, orgId),
      ))
      .returning();
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
      const [existing] = await db
        .select({ cronExpression: schema.complianceScanSchedule.cronExpression })
        .from(schema.complianceScanSchedule)
        .where(and(
          eq(schema.complianceScanSchedule.id, id),
          eq(schema.complianceScanSchedule.orgId, orgId),
        ));
      if (existing) {
        updates.nextRunAt = calculateNextRun(existing.cronExpression);
      }
    }

    const [updated] = await db
      .update(schema.complianceScanSchedule)
      .set(updates)
      .where(and(
        eq(schema.complianceScanSchedule.id, id),
        eq(schema.complianceScanSchedule.orgId, orgId),
      ))
      .returning();
    return updated ?? null;
  }

  /** Soft-delete: marks the schedule inactive. Same return contract as toggleActive. */
  async softDelete(id: string, orgId: string) {
    const [deleted] = await db
      .update(schema.complianceScanSchedule)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(
        eq(schema.complianceScanSchedule.id, id),
        eq(schema.complianceScanSchedule.orgId, orgId),
      ))
      .returning();
    return deleted ?? null;
  }
}

export const complianceScanScheduleService = new ComplianceScanScheduleService();
