// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deploying a never-deployed pipeline through a pipeline runner.
 *
 * - GET  /pipelines/:pipelineId/deploy-targets                 pipelines:write — every eligible runner, deployable or not (with its reason), and the one used when none is named.
 * - POST /pipelines/:pipelineId/deploys                        pipelines:write + MFA-grade + step-up — queue the deploy (202 QueuedDeployDto); DEPLOY_REQUESTS_PER_HOUR per org (fail closed).
 * - GET  /pipelines/:pipelineId/deploys/latest                 pipelines:read — the pipeline's most recent deploy (404 when it has none).
 * - GET  /pipelines/:pipelineId/deploys/:requestId             pipelines:read — one deploy's progress (DeployRequestDto).
 * - POST /pipelines/:pipelineId/deploys/:requestId/cancel      pipelines:write — cancel it.
 *
 * Self-guarded per route (mounted with the runner routes, before the read
 * router's `/:id`). The deploy re-runs the pipeline's compliance check (fail
 * closed) and resolves its managed toolchain release (the cdk-synth image the
 * runner's job runs, pinned by digest). No pipelines quota is spent: the
 * pipeline already exists. Never an AWS account id, a grant or a URL in any
 * answer, log line or audit entry.
 */

import { actorId, audited, ErrorCode, getParam, recordAudit, requireAssurance, requirePermission, requireStepUp, sendBadRequest, sendError, sendSuccess, toolchainReleasePin } from '@pipeline-builder/api-core';
import { AWS_REGION_PATTERN, type DeployTargetsDto } from '@pipeline-builder/api-core/pipeline-runners';
import { createAuthenticatedWithOrgRoute, withRoute } from '@pipeline-builder/api-server';
import { deployedPipelineNames } from '@pipeline-builder/pipeline-core';
import { ManagedToolchainError, resolveManagedToolchain } from '@pipeline-builder/pipeline-data';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { requireRunnersAvailable } from './runner-routes.js';
import { checkPipelineUpdateCompliance } from '../helpers/pipeline-update-compliance.js';
import { startDeploy, deployTargets, type DeployPipelineFacts } from '../runners/deploy-routing.js';
import { cancelDeploy, deployDto, readDeploy } from '../runners/deploys.js';
import { runnerDeps } from '../runners/deps.js';
import { RunnerRouteError } from '../runners/routing.js';
import { pipelineRegistryService } from '../services/pipeline-registry-service.js';
import { pipelineService } from '../services/pipeline-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const StartSchema = z.object({
  runnerId: z.string().regex(UUID, 'runnerId must be a runner id').optional(),
  region: z.string().regex(AWS_REGION_PATTERN, 'region must be an AWS region name').optional(),
}).strict();

function sendRunnerError(res: Response, err: unknown): boolean {
  if (!(err instanceof RunnerRouteError)) return false;
  sendError(res, err.status, err.message, err.code, err.details);
  return true;
}

/** The caller's OWN pipeline (a public / parent pipeline is never deployed by another org), or null. */
async function ownPipeline(req: Request, orgId: string) {
  const id = (getParam(req.params, 'pipelineId') ?? '').toLowerCase();
  if (!UUID.test(id)) return null;
  const row = await pipelineService.findById(id, orgId);
  return row && row.orgId.toLowerCase() === orgId.toLowerCase() ? row : null;
}

type PipelineRow = NonNullable<Awaited<ReturnType<typeof ownPipeline>>>;

/** The names a deploy records (pipeline-core's single naming source), or null when they can't be derived. */
function namesOf(row: PipelineRow): { pipelineName: string; stackName: string } | null {
  try {
    return deployedPipelineNames({
      pipelineName: row.pipelineName, project: row.project, organization: row.organization, props: (row.props ?? {}) as unknown as Record<string, unknown>,
    });
  } catch {
    return null;
  }
}

export function createDeployRoutes(): Router {
  const router = Router();
  const base = createAuthenticatedWithOrgRoute();
  const stepUp = [requireAssurance({ minAssurance: 2 }) as RequestHandler, requireStepUp as RequestHandler];
  const notFound = (res: Response) => sendError(res, 404, 'Pipeline not found.', ErrorCode.NOT_FOUND);

  router.get('/:pipelineId/deploy-targets', ...base, requirePermission('pipelines:write'), withRoute(async ({ req, res, orgId }) => {
    const row = await ownPipeline(req, orgId);
    if (!row) return notFound(res);
    const names = namesOf(row);
    if (!names) return sendBadRequest(res, 'The pipeline\'s deployed names can\'t be derived (project and organization are required).', ErrorCode.VALIDATION_ERROR);
    const registered = (await pipelineRegistryService.deploymentOf(row.id)) !== null;
    const dto: DeployTargetsDto = await deployTargets(runnerDeps(), {
      pipelineId: row.id, orgId, ...(req.user?.parentOrganizationId ? { parentOrgId: req.user.parentOrganizationId } : {}), ...names, registered,
    });
    return sendSuccess(res, 200, dto);
  }));

  router.post('/:pipelineId/deploys', ...base, requirePermission('pipelines:write'), requireRunnersAvailable, ...stepUp, audited('pipeline.deploy.request'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const body = StartSchema.safeParse(req.body ?? {});
      if (!body.success) return sendBadRequest(res, body.error.issues[0]?.message ?? 'Invalid body', ErrorCode.VALIDATION_ERROR);
      const row = await ownPipeline(req, orgId);
      if (!row) return notFound(res);
      const names = namesOf(row);
      if (!names) return sendBadRequest(res, 'The pipeline\'s deployed names can\'t be derived (project and organization are required).', ErrorCode.VALIDATION_ERROR);
      const audit = (outcome: 'success' | 'failure', details: Record<string, unknown>) => recordAudit({
        action: 'pipeline.deploy.request',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'pipeline',
        targetId: row.id,
        ...(outcome === 'failure' ? { outcome } : {}),
        details: { pipelineId: row.id, ...details },
      });

      // The deploy puts the pipeline into an account: re-check compliance as it is now (fail closed).
      const verdict = await checkPipelineUpdateCompliance(orgId, row as unknown as { id: string; pipelineName?: string | null }, {});
      if (verdict.status === 'blocked') {
        audit('failure', { reason: ErrorCode.COMPLIANCE_VIOLATION });
        return sendError(res, 403, 'Deploy blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, { violations: verdict.violations });
      }
      if (verdict.status === 'unavailable') {
        ctx.log('ERROR', 'Compliance service unavailable — deploy rejected', { error: verdict.error });
        return sendError(res, 503, 'Compliance service unavailable — deploy rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
      }

      let toolchain: DeployPipelineFacts['toolchain'];
      try {
        const pin = toolchainReleasePin(row.props);
        const resolved = await resolveManagedToolchain({ orgId }, pin ? { releasePin: pin } : {});
        toolchain = { releaseVersion: resolved.releaseVersion, imageDigest: resolved.synth.imageDigest ?? null, deployJobProtocol: resolved.deployJobProtocol };
      } catch (err) {
        if (err instanceof ManagedToolchainError) return sendError(res, err.statusCode, err.message, err.code, err.details);
        throw err;
      }
      const registered = (await pipelineRegistryService.deploymentOf(row.id)) !== null;
      try {
        const queued = await startDeploy(runnerDeps(), {
          pipelineId: row.id, orgId, ...(req.user?.parentOrganizationId ? { parentOrgId: req.user.parentOrganizationId } : {}), ...names, registered, toolchain,
        }, body.data, userId);
        const { runnerId, ...dto } = queued;
        ctx.log('COMPLETED', 'Deploy queued', { pipelineId: row.id, requestId: dto.requestId, reused: dto.reused });
        if (!dto.reused) audit('success', { requestId: dto.requestId, runnerId, region: dto.region, toolchainRelease: toolchain.releaseVersion });
        return sendSuccess(res, 202, dto);
      } catch (err) {
        if (err instanceof RunnerRouteError) audit('failure', { reason: err.code, ...(err.details?.reason ? { detail: err.details.reason } : {}) });
        if (sendRunnerError(res, err)) return;
        throw err;
      }
    }));

  router.get('/:pipelineId/deploys/latest', ...base, requirePermission('pipelines:read'), withRoute(async ({ req, res, orgId }) => {
    const pipelineId = (getParam(req.params, 'pipelineId') ?? '').toLowerCase();
    if (!UUID.test(pipelineId)) return sendError(res, 404, 'No deploy yet.', ErrorCode.NOT_FOUND);
    const dto = await readDeploy(runnerDeps(), orgId, pipelineId, 'latest');
    if (!dto) return sendError(res, 404, 'No deploy yet.', ErrorCode.NOT_FOUND);
    res.setHeader('Cache-Control', 'no-store');
    return sendSuccess(res, 200, dto);
  }));

  router.get('/:pipelineId/deploys/:requestId', ...base, requirePermission('pipelines:read'), withRoute(async ({ req, res, orgId }) => {
    const pipelineId = (getParam(req.params, 'pipelineId') ?? '').toLowerCase();
    const requestId = getParam(req.params, 'requestId') ?? '';
    const dto = UUID.test(pipelineId) ? await readDeploy(runnerDeps(), orgId, pipelineId, requestId) : null;
    if (!dto) return sendError(res, 404, 'Deploy not found.', ErrorCode.NOT_FOUND);
    res.setHeader('Cache-Control', 'no-store');
    return sendSuccess(res, 200, dto);
  }));

  router.post('/:pipelineId/deploys/:requestId/cancel', ...base, requirePermission('pipelines:write'), audited('pipeline.deploy.cancel'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const pipelineId = (getParam(req.params, 'pipelineId') ?? '').toLowerCase();
      const requestId = getParam(req.params, 'requestId') ?? '';
      const deps = runnerDeps();
      try {
        const pair = await cancelDeploy(deps, orgId, pipelineId, requestId, userId);
        const runner = pair.request.runnerId ? await deps.store.getRunner(pair.request.runnerId) : null;
        ctx.log('COMPLETED', 'Deploy cancel requested', { requestId, status: pair.request.status });
        recordAudit({
          action: 'pipeline.deploy.cancel',
          actorId: actorId({ userId }),
          orgId,
          targetType: 'pipeline',
          targetId: pair.request.pipelineId,
          details: { pipelineId: pair.request.pipelineId, requestId, runnerId: pair.request.runnerId, status: pair.request.status, stage: pair.deploy.stage },
        });
        return sendSuccess(res, 200, deployDto(pair.request, pair.deploy, runner));
      } catch (err) {
        if (sendRunnerError(res, err)) return;
        throw err;
      }
    }));

  return router;
}
