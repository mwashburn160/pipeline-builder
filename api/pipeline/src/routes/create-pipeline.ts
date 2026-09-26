// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AppError, extractDbError, ErrorCode, createLogger, errorMessage, requirePermission, sendBadRequest, sendError, sendInternalError, sendSuccess, validateBody, PipelineCreateSchema, audited, proposable } from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withQuotaReservation, withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { describeDeployAttribution, previewStructure } from '@pipeline-builder/pipeline-core';
import { createOnePipeline, preparePipelineCreate, validatePipelineWrite } from '../helpers/pipeline-write.js';

const logger = createLogger('create-pipeline');

/**
 * Register the CREATE route on a router.
 *
 * Uses the "atomic reserve + rollback on failure" pattern for the
 * `pipelines` quota: the slot is reserved at the start of the handler so
 * two concurrent requests at the limit can't both create pipelines. The
 * slot is given back (`withQuotaReservation`) if the action fails after the
 * reservation lands. The guard chain is `createAuthenticatedWithOrgRoute`
 * (no `checkQuota` pre-flight), so no separate check races the reservation.
 */
export function createCreatePipelineRoutes( quotaService: QuotaService,
): Router {
  const router: Router = Router();

  router.post( '/',
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('pipelines:write'),
    // `inserted === false` means `?upsert=true` overwrote an existing pipeline,
    // which is audited as an update rather than a create.
    audited('pipeline.create', 'pipeline.update'),
    proposable,
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const validation = validateBody(req, PipelineCreateSchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      }
      const body = validation.value;

      // Opt-in overwrite of a live same-slot pipeline. Without it the service
      // refuses with 409 rather than replacing a pipeline's props behind a 201.
      const upsert = req.query.upsert === 'true';

      const rejection = await validatePipelineWrite(body, orgId, req.user?.parentOrganizationId);
      if (rejection) return sendError(res, rejection.status, rejection.message, rejection.code, rejection.details);

      const prepared = preparePipelineCreate(req, body);
      if ('error' in prepared) return sendBadRequest(res, prepared.error, ErrorCode.VALIDATION_ERROR);

      // The reservation's minted service token also authenticates the downstream
      // compliance call: the caller's bearer may carry only end-user scopes that
      // service-to-service authorization rejects. The slot is reserved atomically
      // before any work runs and given back whenever no pipeline was created.
      const reserved = await withQuotaReservation({
        quotaService, orgId, type: 'pipelines', serviceName: 'pipeline', res, logWarn: ctx.log.bind(null, 'WARN'),
      }, async (slot) => {
        ctx.log('INFO', 'Pipeline creation request received', { project: prepared.project, organization: prepared.organization });

        const outcome = await createOnePipeline(req, body, prepared, { orgId, userId, serviceAuth: slot.serviceAuth, upsert });

        if (outcome.status === 'blocked') {
          ctx.log('WARN', 'Pipeline creation blocked by compliance', {
            project: prepared.project, violations: outcome.violations.length,
          });
          slot.refund();
          return sendError(res, 403, 'Pipeline creation blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, {
            violations: outcome.violations,
          });
        }
        if (outcome.status === 'unavailable') {
          ctx.log('ERROR', 'Compliance service unavailable', { error: outcome.error });
          slot.refund();
          return sendError(res, 503, 'Compliance service unavailable — pipeline creation rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
        }

        const { pipeline: result, inserted } = outcome;

        // The upsert UPDATED an existing default rather than inserting a
        // net-new pipeline, so no create happened — give the reserved slot back
        // so repeated creates for the same org/project don't over-count the
        // per-period `pipelines` create quota.
        if (!inserted) slot.refund();

        ctx.log('COMPLETED', inserted ? 'Pipeline created' : 'Pipeline overwritten (upsert)', { id: result.id });

        // An overwrite created nothing, so it is not a 201: the caller asked for
        // `?upsert=true` and gets 200 with `inserted: false`, matching PUT.
        //
        // The visibility RUNG leads the message. Who can see a pipeline is the
        // thing a creator most needs told back, and `org` is the default — so it
        // is the unmarked case and the other two are named.
        const audience = result.visibility === 'public'
          ? 'accessible to all organizations'
          : result.visibility === 'private'
            ? 'accessible to its author only'
            : `accessible to organization ${orgId}`;
        const rung = result.visibility === 'public' ? 'Public ' : result.visibility === 'private' ? 'Private ' : '';
        const message = inserted
          ? `${rung}${rung ? 'pipeline' : 'Pipeline'} created successfully (${audience})`
          : `Existing ${rung.toLowerCase()}pipeline updated in place (${audience})`;

        // The DORA deploy signal this config will produce, and why it may be
        // wrong. These warnings previously reached a synth log only, which nobody
        // reads until the reports are already attributing deploys to the wrong
        // stage. Derived without synthesizing — see describeDeployAttribution.
        const attribution = describeDeployAttribution(body.props);

        return sendSuccess(res, inserted ? 201 : 200, {
          inserted,
          ...(attribution.warnings.length > 0
            ? { warnings: attribution.warnings.map((w) => w.message) }
            : {}),
          deploys: attribution.deploys,
          // What was actually built: stages, plugin versions and how the IAM role
          // is obtained — so a reviewer reading the create's response, or an audit
          // of it later, sees the structure and not just an id.
          preview: previewStructure(body.props),
          pipeline: {
            id: result.id,
            project: result.project,
            organization: result.organization,
            pipelineName: result.pipelineName,
            visibility: result.visibility,
            isDefault: result.isDefault,
            isActive: result.isActive,
            createdAt: result.createdAt,
            createdBy: result.createdBy,
          },
        }, message);
      }, (error) => {
        // A typed refusal from the service (403 not-writable / 409 tombstone or
        // another author's private pipeline) is a client outcome, not a save
        // failure — let withRoute map it to its own status.
        if (error instanceof AppError) throw error;

        // The message and the sanitized DB metadata (constraint/table names) stay
        // in the log, correlated by requestId. Echoing them told an unauthenticated
        // caller the schema's constraint names and, for a driver error, the SQL.
        logger.error('Pipeline save failed', {
          requestId: ctx.requestId, error: errorMessage(error), orgId, ...extractDbError(error),
        });
        sendInternalError(res, 'Failed to save pipeline configuration', { requestId: ctx.requestId });
      });
      if (reserved.status === 'denied') {
        const { reservation } = reserved;
        ctx.log('WARN', reservation.unavailable ? 'Pipeline quota unconfirmable (quota service unavailable)' : 'Pipeline quota exceeded', { orgId, used: reservation.quota.used, limit: reservation.quota.limit });
      }
    }),
  );

  return router;
}
