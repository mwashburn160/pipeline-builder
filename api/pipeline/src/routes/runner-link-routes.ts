// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner link of a pipeline, as the dashboard shows and refreshes it. The
 * runner is always FOUND (by the pipeline's pb.pipeline-id tag, which only the
 * runner can see), never picked by hand.
 *
 * - GET  /pipelines/:pipelineId/runner-link          pipelines:read — status, runner, last checked, runners checked.
 * - POST /pipelines/:pipelineId/runner-link/refresh  pipelines:write + MFA-grade + step-up, 5/org/min —
 *        queue a re-probe (202, `checking`). A single match replaces the link;
 *        anything else keeps the old link and records the result.
 * - GET  /pipelines/runners/:id/pipelines            org_settings:write — the pipelines linked to one of the org's runners.
 *
 * Nothing here returns an AWS account id or a runner URL: the detail carries
 * runner labels only.
 */

import {
  actorId,
  audited,
  ErrorCode,
  getParam,
  parsePaginationParams,
  recordAudit,
  requireAssurance,
  requirePermission,
  requireStepUp,
  sendError,
  sendPaginatedNested,
  sendSuccess,
} from '@pipeline-builder/api-core';
import { RUNNER_LINK_REFRESHES_PER_MINUTE, runnerErrorStatus, type RunnerLinkDto } from '@pipeline-builder/api-core/pipeline-runners';
import { createAuthenticatedWithOrgRoute, rateLimitByOrg, withRoute } from '@pipeline-builder/api-server';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { ownRunner } from '../runners/admin.js';
import { runnerDeps, type RunnerDeps } from '../runners/deps.js';
import { asRunnerRouteError, probeRunnerLink } from '../runners/routing.js';
import type { RegistryLink } from '../runners/store.js';
import { pipelineService } from '../services/pipeline-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 409 RUNNERS_UNAVAILABLE (paused, no secret encryption, no runner tables) — checked before a step-up is spent. */
async function requireRunnersAvailable(_req: Request, res: Response, next: NextFunction): Promise<void> {
  const state = await runnerDeps().runnersAvailable();
  if (!state.available) {
    return sendError(res, runnerErrorStatus('RUNNERS_UNAVAILABLE'), 'Pipeline runners are unavailable on this deployment right now.', 'RUNNERS_UNAVAILABLE', { reason: state.reason ?? null });
  }
  next();
}

/** The registry link of a pipeline the caller can see, or null (unknown, not registered, not visible). */
async function visibleLink(deps: RunnerDeps, pipelineId: string, orgId: string): Promise<RegistryLink | null> {
  if (!UUID.test(pipelineId)) return null;
  if (!(await pipelineService.findById(pipelineId, orgId))) return null;
  return deps.store.getRegistryLink(pipelineId, orgId);
}

/** The DTO of a registry link (the linked runner's owner named when it is an ancestor's). */
export async function runnerLinkDto(deps: RunnerDeps, pipelineId: string, orgId: string, link: RegistryLink, statusOverride?: RunnerLinkDto['status']): Promise<RunnerLinkDto> {
  const runner = link.runnerId ? await deps.store.getRunner(link.runnerId) : null;
  const ownerOrgName = runner && runner.orgId !== orgId
    ? (await deps.hierarchy.names([runner.orgId]))[runner.orgId.toLowerCase()] ?? null
    : null;
  const availability = await deps.runnersAvailable();
  return {
    pipelineId: pipelineId.toLowerCase(),
    status: statusOverride ?? link.linkStatus ?? (link.runnerId ? 'linked' : 'unlinked'),
    runner: runner ? {
      id: runner.id,
      label: runner.label,
      health: runner.health,
      lastDeliveryAt: runner.lastDeliveryAt ? runner.lastDeliveryAt.toISOString() : null,
      ownerOrgName,
    } : null,
    checkedAt: link.linkCheckedAt ? link.linkCheckedAt.toISOString() : null,
    detail: link.linkDetail ?? null,
    deliveriesPaused: !availability.available && availability.reason === 'paused',
  };
}

export function createRunnerLinkRoutes(): Router {
  const router = Router();
  const readGuards = [...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:read')];
  const refreshGuards = [
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('pipelines:write'),
    requireRunnersAvailable,
    requireAssurance({ minAssurance: 2 }) as RequestHandler,
    requireStepUp as RequestHandler,
    rateLimitByOrg({ name: 'pipeline-runner-link-refresh', max: RUNNER_LINK_REFRESHES_PER_MINUTE, windowMs: 60_000, message: 'Too many runner-link refreshes; wait a minute and try again.' }),
  ];
  const admin = [...createAuthenticatedWithOrgRoute(), requirePermission('org_settings:write')];

  router.get('/:pipelineId/runner-link', ...readGuards, withRoute(async ({ req, res, orgId }) => {
    const pipelineId = getParam(req.params, 'pipelineId') ?? '';
    const deps = runnerDeps();
    if (!(await deps.store.tablesPresent().catch(() => false))) {
      return sendError(res, runnerErrorStatus('RUNNERS_UNAVAILABLE'), 'Pipeline runners are unavailable on this deployment right now.', 'RUNNERS_UNAVAILABLE', { reason: 'tables_missing' });
    }
    const link = await visibleLink(deps, pipelineId, orgId);
    if (!link) return sendError(res, 404, 'Pipeline is not registered.', ErrorCode.NOT_FOUND);
    return sendSuccess(res, 200, await runnerLinkDto(deps, pipelineId, orgId, link));
  }));

  router.post('/:pipelineId/runner-link/refresh', ...refreshGuards, audited('pipeline.runner.link.refresh'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const pipelineId = (getParam(req.params, 'pipelineId') ?? '').toLowerCase();
    const deps = runnerDeps();
    const link = await visibleLink(deps, pipelineId, orgId);
    if (!link) return sendError(res, 404, 'Pipeline is not registered.', ErrorCode.NOT_FOUND);
    await deps.store.writeRunnerLink(pipelineId, orgId, { status: 'checking', checkedAt: new Date(deps.now()), detail: link.linkDetail ?? null });
    const dto = await runnerLinkDto(deps, pipelineId, orgId, { ...link, linkCheckedAt: new Date(deps.now()) }, 'checking');
    const parentOrgId = req.user?.parentOrganizationId;
    // The probe runs after the answer; its outcome is the row's status (the
    // page polls GET …/runner-link) and the audit entry. Labels only.
    void probeRunnerLink(deps, { pipelineId, orgId, requestedBy: userId, ...(parentOrgId ? { parentOrgId } : {}) }).then(async (status) => {
      const after = await deps.store.getRegistryLink(pipelineId, orgId).catch(() => null);
      recordAudit({
        action: 'pipeline.runner.link.refresh',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'pipeline',
        targetId: pipelineId,
        ...(status === 'linked' ? {} : { outcome: 'failure' as const }),
        details: { status, runnersChecked: after?.linkDetail?.runnersChecked ?? [], matched: after?.linkDetail?.matched ?? [] },
      });
    });
    ctx.log('COMPLETED', 'Queued a runner-link refresh', { pipelineId });
    return sendSuccess(res, 202, dto);
  }));

  router.get('/runners/:id/pipelines', ...admin, withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id') ?? '';
    const deps = runnerDeps();
    if (!(await deps.store.tablesPresent().catch(() => false))) {
      return sendError(res, runnerErrorStatus('RUNNERS_UNAVAILABLE'), 'Pipeline runners are unavailable on this deployment right now.', 'RUNNERS_UNAVAILABLE', { reason: 'tables_missing' });
    }
    try {
      const runner = await ownRunner(deps, orgId, id);
      const { limit, offset } = parsePaginationParams(req.query as Record<string, unknown>);
      const { rows, total } = await deps.store.listRunnerPipelines(runner.id, limit, offset);
      ctx.log('COMPLETED', 'Listed a runner\'s pipelines', { runnerId: runner.id, count: rows.length });
      return sendPaginatedNested(res, 'pipelines', rows, { total, limit, offset });
    } catch (err) {
      const refusal = asRunnerRouteError(err);
      if (refusal) return sendError(res, refusal.status, refusal.message, refusal.code, refusal.details);
      throw err;
    }
  }));

  return router;
}
