// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stage 3 of the nightly plugin CVE remediation, as the plugin service drives
 * it (service-to-service only; helpers/remediation-rollout.ts does the work):
 *
 *   POST /pipelines/internal/plugin-remediations/:remediationId/rollout
 *        → { remediationId, created, orgDefault, counts }   (idempotent)
 *   POST /pipelines/internal/plugin-remediations/:remediationId/cancel
 *        → { remediationId, cancelled }                     (idempotent)
 *
 * Both run as SYSTEM_PLUGIN_REMEDIATION under a sysadmin tenant context; every
 * pipeline move they cause is audited like a manual upgrade. Cancel writes no
 * pipeline config (it drops queued moves and supersedes open proposals of a
 * remediation the plugin service audits), so it declares no audit action.
 */

import {
  audited,
  contractRoute,
  ErrorCode,
  errorMessage,
  createLogger,
  parseContractBody,
  parseContractParams,
  PIPELINE_INTERNAL,
  requireAuth,
  requireInternalService,
  sendBadRequest,
  sendError,
  sendSuccess,
} from '@pipeline-builder/api-core';
import { Router, type Request, type Response } from 'express';
import { rolloutEngine, type RolloutEngine } from '../helpers/remediation-rollout.js';

const logger = createLogger('internal-remediation-routes');

const START = PIPELINE_INTERNAL.startRemediationRollout;
const CANCEL = PIPELINE_INTERNAL.cancelRemediationRollout;

export function createInternalRemediationRoutes(engine: () => RolloutEngine = rolloutEngine): Router {
  const router: Router = Router();

  router.post(
    contractRoute(START, '/pipelines/internal'),
    requireAuth,
    requireInternalService({ callers: START.callers }),
    // The start itself moves nothing (the worker's waves are audited as
    // pipeline.plugin.upgraded); it opens install change requests for pinned,
    // approval-gated or proposed installs.
    audited('plugin.install.change-request'),
    async (req: Request, res: Response) => {
      const params = parseContractParams(START, req);
      if (!params.ok) return sendBadRequest(res, params.error, ErrorCode.VALIDATION_ERROR);
      const body = parseContractBody(START, req);
      if (!body.ok) return sendBadRequest(res, body.error, ErrorCode.VALIDATION_ERROR);
      try {
        const result = await engine().start(params.value.remediationId.toLowerCase(), body.value);
        return sendSuccess(res, 200, result);
      } catch (err) {
        logger.warn('Remediation rollout could not start', { remediationId: params.value.remediationId, error: errorMessage(err) });
        return sendError(res, 500, 'The remediation rollout could not be started; retry.', ErrorCode.INTERNAL_ERROR);
      }
    },
  );

  router.post(
    contractRoute(CANCEL, '/pipelines/internal'),
    requireAuth,
    requireInternalService({ callers: CANCEL.callers }),
    async (req: Request, res: Response) => {
      const params = parseContractParams(CANCEL, req);
      if (!params.ok) return sendBadRequest(res, params.error, ErrorCode.VALIDATION_ERROR);
      const body = parseContractBody(CANCEL, req);
      if (!body.ok) return sendBadRequest(res, body.error, ErrorCode.VALIDATION_ERROR);
      try {
        const remediationId = params.value.remediationId.toLowerCase();
        const cancelled = await engine().cancel(remediationId);
        logger.info('Remediation rollout cancelled', { remediationId, reason: body.value.reason, cancelled });
        return sendSuccess(res, 200, { remediationId, cancelled });
      } catch (err) {
        logger.warn('Remediation rollout could not be cancelled', { remediationId: params.value.remediationId, error: errorMessage(err) });
        return sendError(res, 500, 'The remediation rollout could not be cancelled; retry.', ErrorCode.INTERNAL_ERROR);
      }
    },
  );

  return router;
}
