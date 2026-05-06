// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendPaginatedNested,
  sendBadRequest,
  sendEntityNotFound,
  ErrorCode,
  getParam,
  parsePaginationParams,
  validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { isValidCronExpression } from '../helpers/scan-scheduler';
import { complianceScanScheduleService } from '../services/compliance-scan-schedule-service';

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
    const { schedules, total } = await complianceScanScheduleService.list(orgId, limit, offset);
    ctx.log('COMPLETED', 'Listed scan schedules', { count: schedules.length });
    return sendPaginatedNested(res, 'schedules', schedules, {
      total, limit, offset, hasMore: offset + schedules.length < total,
    });
  }));

  // POST / — create a scan schedule
  router.post('/', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, ScheduleCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { target, cronExpression } = validation.value;
    if (!isValidCronExpression(cronExpression)) {
      return sendBadRequest(res, `Invalid cron expression: '${cronExpression}'. Expected 5-field cron with parseable minute/hour fields.`, ErrorCode.VALIDATION_ERROR);
    }

    const schedule = await complianceScanScheduleService.create(orgId, userId, target, cronExpression);
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

    if (validation.value.cronExpression && !isValidCronExpression(validation.value.cronExpression)) {
      return sendBadRequest(res, `Invalid cron expression: '${validation.value.cronExpression}'. Expected 5-field cron with parseable minute/hour fields.`, ErrorCode.VALIDATION_ERROR);
    }

    const updated = await complianceScanScheduleService.update(id, orgId, userId, validation.value);
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

    const updated = await complianceScanScheduleService.toggleActive(id, orgId, userId, validation.value.isActive);
    if (!updated) return sendEntityNotFound(res, 'Scan schedule');

    ctx.log('COMPLETED', 'Toggled scan schedule active', { scheduleId: id, isActive: validation.value.isActive });
    return sendSuccess(res, 200, { schedule: updated });
  }));

  // DELETE /:id — deactivate/remove a scan schedule
  router.delete('/:id', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendEntityNotFound(res, 'Scan schedule');

    const deleted = await complianceScanScheduleService.softDelete(id, orgId);
    if (!deleted) return sendEntityNotFound(res, 'Scan schedule');

    ctx.log('COMPLETED', 'Deleted scan schedule', { scheduleId: id });
    return sendSuccess(res, 200, { schedule: deleted });
  }));

  return router;
}
