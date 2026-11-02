// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  actorId,
  audited,
  ErrorCode,
  errorMessage,
  getParam,
  hasScope,
  recordAudit,
  recordAuthzDenial,
  requirePermission,
  sendBadRequest,
  sendEntityNotFound,
  sendError,
  sendSuccess,
  tagRouteGate,
  userHasPermission,
  validateBody,
} from '@pipeline-builder/api-core';
import type { TokenScope } from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withRoute } from '@pipeline-builder/api-server';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { normalizeSecurityReport, SECURITY_REPORT_FORMATS } from '../helpers/security-report.js';
import { pipelineService } from '../services/pipeline-service.js';
import { securityReportStore, summarizeReports } from '../services/security-report-store.js';

const UploadSchema = z.object({
  /** The scanner (`trivy`, `grype`, `semgrep`, …): one stored report per (tool, stage). */
  tool: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'tool must be a scanner name (letters, digits, . _ -)'),
  format: z.enum(SECURITY_REPORT_FORMATS),
  executionId: z.string().min(1).max(255).optional(),
  stage: z.string().min(1).max(255).optional(),
  /** The tool's raw report. Size-capped by the service's JSON body limit (1 MB). */
  report: z.record(z.string(), z.unknown()),
});

/** The scope of the least-privilege key a scan step uploads with (pipeline-core `security-reports.ts`). */
const UPLOAD_SCOPE: TokenScope = 'reporting:ingest';

/**
 * Upload gate: the org's `reporting:ingest`-SCOPED key — what a scan step holds
 * (`PB_SECURITY_REPORT_KEY`); a scoped token carries no permissions, so a plain
 * `requirePermission` would refuse every step — OR a member holding
 * `pipelines:write`. Either way the org is the token's own (`requireOrgId` ran
 * first), and the pipeline must belong to it. Use after `requireAuth`.
 */
export function requireReportUploader(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) return sendError(res, 401, 'Authentication required', ErrorCode.UNAUTHORIZED);
  if (hasScope(req, UPLOAD_SCOPE) || userHasPermission(req, 'pipelines:write')) return next();
  recordAuthzDenial(req, `pipelines:write or scope:${UPLOAD_SCOPE}`);
  return sendError(res, 403, `Requires pipelines:write or a '${UPLOAD_SCOPE}'-scoped key`, ErrorCode.INSUFFICIENT_PERMISSIONS);
}
// Either credential admits the upload: the table records both the member
// permission (what the frontend's can(...) reads) and the machine scope.
tagRouteGate(requireReportUploader,
  { kind: 'permission', mode: 'any', permissions: ['pipelines:write'] },
  { kind: 'scope', scope: UPLOAD_SCOPE });

/**
 * Application-artifact security reports — what a pipeline's OWN scan steps
 * found in what it builds (helpers/security-report.ts).
 *
 * - POST /:id/security-reports — {@link requireReportUploader}. The caller is the
 *   pipeline's CodeBuild scan step, authenticated with the org's
 *   `reporting:ingest`-scoped key (`PB_SECURITY_REPORT_KEY`, never the
 *   full-privilege platform secret), or a member with `pipelines:write`.
 *   The report is normalized on the way in; one that is not the declared format
 *   is a 400 (an unreadable scan is unknown, never clean). Replaces the latest
 *   report for its (tool, stage), audited `pipeline.security_report.upload`.
 * - GET /:id/security-reports — `pipelines:read`. The latest report per
 *   (tool, stage) plus their summed counts.
 *
 * Self-guarded per route (mounted with the other self-guarded routers); apiCalls
 * is metered + checked by the '/pipelines' prefix mount in app-routes.ts.
 */
export function createSecurityReportRoutes(): Router {
  const router = Router();

  router.post('/:id/security-reports',
    ...createAuthenticatedWithOrgRoute(), requireReportUploader, audited('pipeline.security_report.upload'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const id = getParam(req.params, 'id');
      if (!id) return sendBadRequest(res, 'Pipeline id is required.', ErrorCode.MISSING_REQUIRED_FIELD);
      const validation = validateBody(req, UploadSchema);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const body = validation.value;

      const pipeline = await pipelineService.findById(id, orgId);
      if (!pipeline) return sendEntityNotFound(res, 'Pipeline');

      let normalized;
      try {
        normalized = normalizeSecurityReport(body.format, body.report);
      } catch (err) {
        return sendBadRequest(res, `Report is not valid ${body.format}: ${errorMessage(err)}`, ErrorCode.VALIDATION_ERROR);
      }

      const stored = await securityReportStore().put({
        orgId,
        pipelineId: id,
        tool: body.tool.toLowerCase(),
        format: body.format,
        stage: body.stage ?? '',
        executionId: body.executionId ?? null,
        counts: normalized.counts,
        findings: normalized.findings,
        truncated: normalized.truncated,
        submittedBy: actorId({ userId }),
      });
      ctx.log('COMPLETED', 'Stored security report', { id, tool: stored.tool, stage: stored.stage, ...normalized.counts });

      recordAudit({
        action: 'pipeline.security_report.upload',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'pipeline',
        targetId: id,
        details: {
          reportId: stored.id,
          tool: stored.tool,
          format: stored.format,
          stage: stored.stage,
          ...(stored.executionId ? { executionId: stored.executionId } : {}),
          counts: normalized.counts,
        },
      });

      return sendSuccess(res, 201, { report: stored });
    }));

  router.get('/:id/security-reports',
    ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:read'),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const id = getParam(req.params, 'id');
      if (!id) return sendBadRequest(res, 'Pipeline id is required.', ErrorCode.MISSING_REQUIRED_FIELD);
      const pipeline = await pipelineService.findById(id, orgId);
      if (!pipeline) return sendEntityNotFound(res, 'Pipeline');

      const reports = await securityReportStore().latest(orgId, [id]);
      const { counts, latestAt } = summarizeReports(reports);
      ctx.log('COMPLETED', 'Listed security reports', { id, reports: reports.length });
      return sendSuccess(res, 200, { pipelineId: id, reports, counts, latestAt: latestAt?.toISOString() ?? null });
    }));

  return router;
}
