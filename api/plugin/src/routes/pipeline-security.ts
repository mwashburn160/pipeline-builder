// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A pipeline's plugin security, ORG-LOCAL, mounted at `/plugins` behind the
 * shared auth + org chain (before the read routes, so `/:id` never sees them):
 *
 *   GET  /plugins/pipelines/:pipelineId/security       pipelines:read   per step: resolution, last lookup, scan state, exposures
 *   GET  /plugins/pipelines/:pipelineId/exposures      pipelines:read   the pipeline's exposures (`?includeFixed=true` for closed ones)
 *   POST /plugins/pipelines/:pipelineId/exposures/:exposureId/triage
 *                                                      pipelines:write  accept (reason + expiry, `kev: true` for KEV) / false_positive / reopen
 *   POST /plugins/runtime-check                        plugins:read     the current grade of the digests a pipeline runs
 *
 * Every route answers 404 for a pipeline the caller's org does not own (the
 * same answer as one that does not exist). Vulnerability state never blocks a
 * pipeline: the runtime check grades (`ok|info|warning|error|critical`), and a
 * triage only changes how loud a finding is for THIS pipeline.
 */

import { actorId, audited, ErrorCode, requirePermission, sendSuccess } from '@pipeline-builder/api-core';
import { pipelineExposures } from '@pipeline-builder/pipeline-data';
import { Router, type RequestHandler } from 'express';

import { bodyOf, ecosystemRoute, param } from './ecosystem-route.js';
import { ownedPipeline } from '../helpers/lookup-vuln-policy.js';
import { EcosystemError, type Caller } from '../services/ecosystem/context.js';
import {
  parseRuntimeCheck, parseTriage, pipelineSecurity, runtimeCheck, shapeExposure, triagePipelineExposure,
} from '../services/pipeline-security.js';

/** The caller's resolution scope (a team's root org rides along). */
const scopeOf = (caller: Caller) => ({ orgId: caller.orgId, ...(caller.parentOrgId ? { rootOrgId: caller.parentOrgId } : {}) });

async function pipelineOf(caller: Caller, pipelineId: string): Promise<{ id: string; name: string | null }> {
  const pipeline = await ownedPipeline(caller.orgId, pipelineId);
  if (!pipeline) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Pipeline not found');
  return pipeline;
}

/** The pipeline-security routes (mounted at `/plugins`). */
export function createPipelineSecurityRoutes(): Router {
  const router = Router();

  router.get('/pipelines/:pipelineId/security', requirePermission('pipelines:read') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const pipeline = await pipelineOf(caller, param(req, 'pipelineId'));
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, 200, await pipelineSecurity(scopeOf(caller), pipeline));
  }));

  router.get('/pipelines/:pipelineId/exposures', requirePermission('pipelines:read') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const pipeline = await pipelineOf(caller, param(req, 'pipelineId'));
    const exposures = await pipelineExposures(caller.orgId, pipeline.id, { includeFixed: req.query.includeFixed === 'true' });
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, 200, { pipeline, exposures: exposures.map(shapeExposure) });
  }));

  router.post('/pipelines/:pipelineId/exposures/:exposureId/triage', requirePermission('pipelines:write') as RequestHandler,
    audited('pipeline.vuln.accepted', 'pipeline.vuln.false_positive', 'pipeline.vuln.reopened') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      const pipeline = await pipelineOf(caller, param(req, 'pipelineId'));
      const body = parseTriage(bodyOf(req));
      const exposures = await triagePipelineExposure(scopeOf(caller), pipeline.id, param(req, 'exposureId'), body, caller.userId);
      if (exposures.length === 0) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Exposure not found');
      sendSuccess(res, 200, { exposures });
    }));

  router.post('/runtime-check', requirePermission('plugins:read') as RequestHandler, audited('pipeline.runtime_check.flagged') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const { pipelineId, steps, executionId } = parseRuntimeCheck(bodyOf(req));
    const pipeline = await pipelineOf(caller, pipelineId);
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, 200, await runtimeCheck(scopeOf(caller), pipeline, steps, { actorId: actorId({ userId: caller.userId }), ...(executionId ? { executionId } : {}) }));
  }));

  return router;
}
