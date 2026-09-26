// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  createComplianceClient,
  ErrorCode,
  errorMessage,
  getQuotaServiceAuthHeader,
  requirePermission,
  resolveVisibility,
  sendBadRequest,
  sendSuccess,
  validateBody,
  PipelineCreateSchema,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withRoute } from '@pipeline-builder/api-server';
import { describeDeployAttribution, diffStructure, previewStructure } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import { preparePipelineCreate, validatePipelineWrite } from '../helpers/pipeline-write.js';
import { pipelineService } from '../services/pipeline-service.js';

const complianceClient = createComplianceClient();

/** One reason the create would be refused, tagged with the check that refused it. */
interface ValidationProblem {
  stage: 'schema' | 'name' | 'template' | 'contract' | 'compliance' | 'quota';
  message: string;
  details?: Record<string, unknown>;
}

/**
 * `POST /pipelines/validate` — run every create-time check and write NOTHING.
 *
 * This is what `pipeline-manager pipeline create --dry-run` calls. `--dry-run`
 * used to print the request body and stop, so it could not catch the things that
 * actually reject a create: a compliance rule, a plugin contract, a template
 * error, an exhausted quota or a slot that is already taken. A preview that only
 * echoes the input tells you nothing you did not already type.
 *
 * Reports ALL problems rather than stopping at the first, because the point is to
 * fix them in one pass. So the response is 200 with `valid: false` and a list —
 * not a 4xx per problem. A body that is not a JSON object is still a 400: there
 * is nothing to report on.
 *
 * Compliance runs through `dryRunPipeline` (no audit event, no notification) —
 * validating must not look like a create attempt in the audit trail. Unlike the
 * real create this is NOT fail-closed: a compliance outage becomes a warning, so
 * the other checks still report. The create itself remains fail-closed.
 */
export function createValidatePipelineRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  router.post('/validate',
    ...createAuthenticatedWithOrgRoute(),
    // Same permission as create: this reports whether YOUR create would land,
    // and it evaluates the org's compliance rules against a submitted config.
    requirePermission('pipelines:write'),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const problems: ValidationProblem[] = [];
      const warnings: ValidationProblem[] = [];

      // A body that is not a JSON OBJECT is a client bug, not a config problem —
      // there is nothing to report on, so it is a 400 rather than a 200 report.
      if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
        return sendBadRequest(res, 'Request body must be a pipeline configuration object', ErrorCode.VALIDATION_ERROR);
      }

      const validation = validateBody(req, PipelineCreateSchema);
      if (!validation.ok) {
        // Schema failure ends the report: every later check reads fields this
        // one just rejected. Still 200 — the caller asked "is this valid?" and
        // this is the answer.
        return sendSuccess(res, 200, {
          valid: false,
          problems: [{ stage: 'schema', message: validation.error }],
          warnings: [],
        }, 'Pipeline configuration is not valid');
      }
      const body = validation.value;

      const prepared = preparePipelineCreate(req, body);
      if ('error' in prepared) {
        return sendSuccess(res, 200, {
          valid: false,
          problems: [{ stage: 'name', message: prepared.error }],
          warnings: [],
        }, 'Pipeline configuration is not valid');
      }
      const { project, organization, pipelineName } = prepared;
      const visibility = resolveVisibility(req, body.visibility, 'pipelines:publish', 'org');

      // Templates + plugin contracts — the same helper the create path runs.
      const rejection = await validatePipelineWrite(body, orgId, req.user?.parentOrganizationId);
      if (rejection) {
        problems.push({
          stage: rejection.code === ErrorCode.TEMPLATE_CONTRACT_VIOLATION ? 'contract' : 'template',
          message: rejection.message,
          ...(rejection.details ? { details: rejection.details } : {}),
        });
      }

      // Compliance, as a pre-flight (no audit, no notification).
      try {
        const verdict = await complianceClient.dryRunPipeline(orgId, {
          project, organization, pipelineName, props: body.props, visibility,
        }, getQuotaServiceAuthHeader(orgId));
        for (const v of verdict.violations) {
          problems.push({ stage: 'compliance', message: v.message });
        }
      } catch (err) {
        // Not fail-closed: a validate is a preview, and refusing to report the
        // other checks because compliance is down makes --dry-run useless during
        // an outage. The create it previews is still fail-closed.
        warnings.push({
          stage: 'compliance',
          message: `Compliance rules could not be evaluated (${errorMessage(err)}). The create itself will be refused while the compliance service is unavailable.`,
        });
      }

      // Quota — read-only `check`, never a reserve: a dry run must not consume a
      // slot. `failOpen` marks the sentinel returned when the service is
      // unreachable, which is a warning rather than a pass.
      let quota: Record<string, unknown> | undefined;
      const q = await quotaService.check(orgId, 'pipelines', getQuotaServiceAuthHeader(orgId), ctx.requestId);
      if (q.failOpen) {
        warnings.push({ stage: 'quota', message: 'Pipeline quota could not be read; the create may still be refused for quota.' });
      } else {
        quota = { used: q.used, limit: q.limit, remaining: q.remaining, unlimited: q.unlimited, resetAt: q.resetAt };
        if (!q.allowed) {
          problems.push({ stage: 'quota', message: `Pipeline quota exhausted (${q.used}/${q.limit}); resets ${q.resetAt}.` });
        }
      }

      // Is the slot free? A create into a taken slot is a 409 unless
      // `?upsert=true`, which is the single most useful thing a dry run can
      // report — it is invisible in the request body the old --dry-run printed.
      const existing = await pipelineService.findOneBySlot(project, organization, orgId);
      const slot = existing
        ? { taken: true, pipelineId: existing.id, pipelineName: existing.pipelineName, deleted: existing.deletedAt !== null }
        : { taken: false };

      // What this config will actually build — stages, plugin versions, deploys and
      // how the IAM role is obtained. A reviewer reads this instead of raw props.
      const preview = previewStructure(body.props);
      // When the slot is taken, the interesting question is not "what would this
      // build" but "what would it CHANGE", so diff against the stored config.
      let diff: ReturnType<typeof diffStructure> | undefined;
      if (existing) {
        const current = await pipelineService.findById(existing.id, orgId, req.user?.parentOrganizationId);
        if (current?.props) {
          diff = diffStructure(previewStructure(current.props as Parameters<typeof previewStructure>[0]), preview);
        }
      }
      if (slot.taken) {
        warnings.push({
          stage: 'name',
          message: slot.deleted
            ? `A deleted pipeline occupies ${organization}/${project}. Restore or purge it before creating a new one.`
            : `${organization}/${project} already has a pipeline. Create will return 409 unless you pass ?upsert=true (CLI: --upsert).`,
        });
      }

      // What DORA deploy signal this config produces, derived without synthesizing.
      const attribution = describeDeployAttribution(body.props);
      for (const w of attribution.warnings) {
        warnings.push({ stage: 'schema', message: w.message });
      }

      const valid = problems.length === 0;
      ctx.log('COMPLETED', 'Pipeline configuration validated', {
        project, organization, valid, problems: problems.length, warnings: warnings.length,
      });

      return sendSuccess(res, 200, {
        valid,
        problems,
        warnings,
        normalized: { project, organization, pipelineName, visibility },
        slot,
        preview,
        ...(diff ? { diff } : {}),
        deploys: attribution.deploys,
        ...(attribution.deploysTag !== undefined ? { deploysTag: attribution.deploysTag } : {}),
        ...(quota ? { quota } : {}),
      }, valid ? 'Pipeline configuration is valid' : 'Pipeline configuration is not valid');
    }),
  );

  return router;
}
