import {
  sendSuccess,
  sendBadRequest,
  sendEntityNotFound,
  ErrorCode,
  getParam,
  parsePaginationParams,
  validateBody,
} from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { schema, db, drizzleCount } from '@mwashburn160/pipeline-core';
import { and, eq, desc, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { calculateNextRun } from '../helpers/scan-scheduler';

/**
 * CRUD routes for compliance scan schedules.
 * Schedules create recurring scans based on cron expressions.
 */

const ScheduleCreateSchema = z.object({
  target: z.enum(['plugin', 'pipeline', 'all']),
  cronExpression: z.string().min(9).max(100),
});

const ScheduleUpdateSchema = z.object({
  target: z.enum(['plugin', 'pipeline', 'all']).optional(),
  cronExpression: z.string().min(9).max(100).optional(),
});

const ToggleActiveSchema = z.object({
  isActive: z.boolean(),
});

export function createScanScheduleRoutes(): Router {
  const router = Router();

  // GET / — list scan schedules for org (paginated)
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query);

    const conditions = [eq(schema.complianceScanSchedule.orgId, orgId)];
    const whereClause = and(...conditions);

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.complianceScanSchedule)
      .where(whereClause).then(r => drizzleCount(r));

    const schedules = await db
      .select()
      .from(schema.complianceScanSchedule)
      .where(whereClause)
      .orderBy(desc(schema.complianceScanSchedule.createdAt))
      .limit(limit)
      .offset(offset);

    const total = countResult?.count ?? 0;
    ctx.log('COMPLETED', 'Listed scan schedules', { count: schedules.length });
    return sendSuccess(res, 200, {
      schedules,
      pagination: { total, limit, offset, hasMore: offset + schedules.length < total },
    });
  }));

  // POST / — create a scan schedule
  router.post('/', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, ScheduleCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { target, cronExpression } = validation.value;
    const nextRunAt = calculateNextRun(cronExpression);

    const [schedule] = await db
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
      .returning();

    ctx.log('COMPLETED', 'Created scan schedule', { scheduleId: schedule.id, cronExpression });
    return sendSuccess(res, 201, { schedule });
  }));

  // PUT /:id — update a scan schedule
  router.put('/:id', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendEntityNotFound(res, 'Scan schedule');

    const validation = validateBody(req, ScheduleUpdateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const updates: Record<string, unknown> = {
      ...validation.value,
      updatedBy: userId,
      updatedAt: new Date(),
    };

    // Recalculate nextRunAt if cronExpression changed
    if (validation.value.cronExpression) {
      updates.nextRunAt = calculateNextRun(validation.value.cronExpression);
    }

    const [updated] = await db
      .update(schema.complianceScanSchedule)
      .set(updates)
      .where(and(
        eq(schema.complianceScanSchedule.id, id),
        eq(schema.complianceScanSchedule.orgId, orgId),
      ))
      .returning();

    if (!updated) return sendEntityNotFound(res, 'Scan schedule');

    ctx.log('COMPLETED', 'Updated scan schedule', { scheduleId: id });
    return sendSuccess(res, 200, { schedule: updated });
  }));

  // PATCH /:id/active — toggle schedule active/inactive
  router.patch('/:id/active', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendEntityNotFound(res, 'Scan schedule');

    const validation = validateBody(req, ToggleActiveSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const updates: Record<string, unknown> = {
      isActive: validation.value.isActive,
      updatedBy: userId,
      updatedAt: new Date(),
    };

    // Recalculate nextRunAt when activating
    if (validation.value.isActive) {
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

    if (!updated) return sendEntityNotFound(res, 'Scan schedule');

    ctx.log('COMPLETED', 'Toggled scan schedule active', { scheduleId: id, isActive: validation.value.isActive });
    return sendSuccess(res, 200, { schedule: updated });
  }));

  // DELETE /:id — deactivate/remove a scan schedule
  router.delete('/:id', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendEntityNotFound(res, 'Scan schedule');

    const [deleted] = await db
      .update(schema.complianceScanSchedule)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(
        eq(schema.complianceScanSchedule.id, id),
        eq(schema.complianceScanSchedule.orgId, orgId),
      ))
      .returning();

    if (!deleted) return sendEntityNotFound(res, 'Scan schedule');

    ctx.log('COMPLETED', 'Deleted scan schedule', { scheduleId: id });
    return sendSuccess(res, 200, { schedule: deleted });
  }));

  return router;
}
