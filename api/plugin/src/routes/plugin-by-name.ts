// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Whole-plugin delete, restore and purge (services/plugin-name-actions.ts):
 *
 *  - GET    /plugins/by-name/:name/delete-preview  plugins:write — what DELETE would delete and skip, and why
 *  - DELETE /plugins/by-name/:name[?force=true]     plugins:write + step-up + limiter — every version it can;
 *                                                    202 { batchId, jobId }, the delete runs as a job
 *  - GET    /plugins/by-name/:name/delete-jobs/:jobId plugins:read — that job's { state, deleted, skipped }
 *  - POST   /plugins/by-name/:name/restore?batchId= plugins:write + step-up + limiter — that batch only
 *  - POST   /plugins/by-name/:name/purge?batchId=   plugins:write + step-up + limiter — that batch only
 *
 * Mounted on `/plugins` BEFORE the read routes (whose `/:id` would otherwise
 * be asked first) and outside the write group's shared step-up: each
 * destructive route layers its OWN `requireStepUp` and answers the request
 * itself, so a step-up token's `jti` is consumed exactly once. The three share
 * one per-org limiter (`PLUGIN_BY_NAME_RATE_LIMIT`, 10 per org per hour).
 */

import {
  audited, checkVisibilityWriteAccess, ErrorCode, getParam, PLUGIN_BY_NAME_RATE_LIMIT, requirePermission, requireStepUp,
  sendBadRequest, sendEntityNotFound, sendSuccess, type QuotaService,
} from '@pipeline-builder/api-core';
import { rateLimitByOrg, withRoute } from '@pipeline-builder/api-server';
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';

import { parentOrgIdOf } from '../helpers/plugin-helpers.js';
import { startDeleteJob, readDeleteJob } from '../services/plugin-delete-jobs.js';
import { previewDeleteByName, purgeByName, restoreByName, type NameActionCaller } from '../services/plugin-name-actions.js';

/** A plugin name as the spec schema allows it. */
const NameSchema = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/);
const BatchIdSchema = z.string().uuid();
const JobIdSchema = z.string().uuid();

function isForce(req: Request): boolean {
  return String(req.query.force ?? '').toLowerCase() === 'true';
}

function callerOf(req: Request, orgId: string, userId: string, log: (level: 'WARN', message: string, data?: unknown) => void): NameActionCaller {
  return {
    orgId,
    userId,
    parentOrgId: parentOrgIdOf(req)?.toLowerCase() ?? null,
    checkWrite: (row) => checkVisibilityWriteAccess(req, row, userId, 'plugins:publish'),
    logWarn: (message, data) => log('WARN', message, data),
  };
}

export function createPluginByNameRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();
  const write = requirePermission('plugins:write') as RequestHandler;
  const read = requirePermission('plugins:read') as RequestHandler;
  const limit = rateLimitByOrg({ ...PLUGIN_BY_NAME_RATE_LIMIT, message: 'Too many whole-plugin deletes, restores or purges; try again later.' }) as RequestHandler;
  const stepUp = requireStepUp as RequestHandler;

  router.get('/by-name/:name/delete-preview', write, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const name = NameSchema.safeParse(getParam(req.params, 'name'));
    if (!name.success) return sendBadRequest(res, 'A valid plugin name is required.', ErrorCode.VALIDATION_ERROR);
    const preview = await previewDeleteByName(name.data, callerOf(req, orgId, userId, ctx.log), { force: isForce(req) });
    return sendSuccess(res, 200, preview);
  }));

  // 202 once accepted; the delete itself runs as a job (services/plugin-delete-jobs.ts).
  router.delete('/by-name/:name', write, audited('plugin.delete-all'), limit, stepUp, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const name = NameSchema.safeParse(getParam(req.params, 'name'));
    if (!name.success) return sendBadRequest(res, 'A valid plugin name is required.', ErrorCode.VALIDATION_ERROR);
    const force = isForce(req);
    ctx.log('INFO', 'Delete-plugin request received', { name: name.data, force });
    const { done, ...accepted } = await startDeleteJob(name.data, callerOf(req, orgId, userId, ctx.log), { force, quotaService });
    void done;
    ctx.log('COMPLETED', 'Delete-plugin job started', { name: name.data, ...accepted });
    return sendSuccess(res, 202, accepted, 'Delete started.');
  }));

  router.get('/by-name/:name/delete-jobs/:jobId', read, withRoute(async ({ req, res, orgId }) => {
    const name = NameSchema.safeParse(getParam(req.params, 'name'));
    if (!name.success) return sendBadRequest(res, 'A valid plugin name is required.', ErrorCode.VALIDATION_ERROR);
    const jobId = JobIdSchema.safeParse(getParam(req.params, 'jobId'));
    if (!jobId.success) return sendBadRequest(res, 'A valid delete job id is required.', ErrorCode.VALIDATION_ERROR);
    const job = await readDeleteJob(orgId, name.data, jobId.data);
    if (!job) return sendEntityNotFound(res, 'Delete job');
    return sendSuccess(res, 200, job);
  }));

  for (const action of ['restore', 'purge'] as const) {
    router.post(`/by-name/:name/${action}`, write, audited(action === 'restore' ? 'plugin.restore-all' : 'plugin.purge-all'), limit, stepUp,
      withRoute(async ({ req, res, ctx, orgId, userId }) => {
        const name = NameSchema.safeParse(getParam(req.params, 'name'));
        if (!name.success) return sendBadRequest(res, 'A valid plugin name is required.', ErrorCode.VALIDATION_ERROR);
        const batchId = BatchIdSchema.safeParse(req.query.batchId);
        if (!batchId.success) return sendBadRequest(res, 'batchId (the delete\'s batch id) is required.', ErrorCode.VALIDATION_ERROR);
        const caller = callerOf(req, orgId, userId, ctx.log);
        const result = action === 'restore'
          ? await restoreByName(name.data, batchId.data, caller, { quotaService })
          : await purgeByName(name.data, batchId.data, caller, { quotaService });
        ctx.log('COMPLETED', action === 'restore' ? 'Restored plugin versions' : 'Purged plugin versions', { name: name.data, batchId: result.batchId, done: result.done.length, skipped: result.skipped.length });
        return sendSuccess(res, 200, result);
      }));
  }

  return router;
}
