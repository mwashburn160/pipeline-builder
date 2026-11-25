// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * First-event self-registration (service-to-service only).
 *
 *   POST /pipelines/internal/registry/first-event → { registered }   (idempotent)
 *
 * Reporting's event ingest calls this when `pb.pipeline-id`-tagged CodePipeline
 * events arrive for pipelines with no registry row — a pipeline created in the
 * dashboard and deployed by anything other than `pipeline-manager pipeline
 * deploy` (CDK directly, a runner, CI). Without it every such event was
 * skipped and the pipeline's runs, reports, DORA metrics and scorecard stayed
 * empty. The registry write lives HERE, the registry's owner, not in reporting.
 *
 * Every row this call inserts is audited `pipeline.registry.register` by the
 * system actor with `details.source: 'first-event'`, and linked to the org's
 * runners in the background like any registration.
 */

import {
  audited,
  contractRoute,
  createLogger,
  ErrorCode,
  errorMessage,
  parseContractBody,
  PIPELINE_INTERNAL,
  recordAudit,
  requireAuth,
  requireInternalService,
  sendBadRequest,
  sendError,
  sendSuccess,
  SYSTEM_ACTOR_ID,
} from '@pipeline-builder/api-core';
import { Router, type Request, type Response } from 'express';
import { runnerDeps } from '../runners/deps.js';
import { linkInBackground } from '../runners/routing.js';
import { SYSTEM_RUNNER_LINK } from '../runners/vocabulary.js';
import { pipelineRegistryService } from '../services/pipeline-registry-service.js';

const logger = createLogger('internal-registry-routes');

const FIRST_EVENT = PIPELINE_INTERNAL.registerFromFirstEvent;

/** Audit `details.source` of a registration made from a pipeline's first event. */
export const FIRST_EVENT_REGISTRATION_SOURCE = 'first-event';

export function createInternalRegistryRoutes(): Router {
  const router: Router = Router();

  router.post(
    contractRoute(FIRST_EVENT, '/pipelines/internal'),
    requireAuth,
    requireInternalService({ callers: FIRST_EVENT.callers }),
    audited('pipeline.registry.register'),
    async (req: Request, res: Response) => {
      const body = parseContractBody(FIRST_EVENT, req);
      if (!body.ok) return sendBadRequest(res, body.error, ErrorCode.VALIDATION_ERROR);
      try {
        const { registered, inserted } = await pipelineRegistryService.registerFromFirstEvent(body.value.pipelines, body.value.allowedOrgIds);
        for (const row of inserted) {
          // `details` carries display metadata only — never an ARN or account id.
          recordAudit({
            action: 'pipeline.registry.register',
            actorId: SYSTEM_ACTOR_ID,
            orgId: row.orgId,
            targetType: 'pipeline',
            targetId: row.pipelineId,
            details: {
              source: FIRST_EVENT_REGISTRATION_SOURCE,
              registryId: row.registryId,
              pipelineName: row.pipelineName,
              project: row.project,
              organization: row.organization,
              stackName: row.stackName,
              ...(row.region ? { region: row.region } : {}),
            },
          });
          void linkInBackground(runnerDeps(), { pipelineId: row.pipelineId, orgId: row.orgId, requestedBy: SYSTEM_RUNNER_LINK });
        }
        if (inserted.length > 0) {
          logger.info('Registered pipelines from their first event', { pipelineIds: inserted.map((r) => r.pipelineId) });
        }
        return sendSuccess(res, 200, { registered });
      } catch (err) {
        logger.warn('First-event registration failed', { error: errorMessage(err) });
        return sendError(res, 500, 'First-event registration failed; the events stay skipped.', ErrorCode.INTERNAL_ERROR);
      }
    },
  );

  return router;
}
