// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  sendError,
  sendPaginatedNested,
  ErrorCode,
  errorMessage,
  extractDbError,
  getParam,
  isSystemAdmin,
  parsePaginationParams,
  TOOLCHAIN_RESOLVED_VIA,
  requirePermission,
  validateBody,
  audited,
  actorId,
  dynamicAuthz,
  recordAudit,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { runnerDeps } from '../runners/deps.js';
import { linkInBackground } from '../runners/routing.js';
import { SYSTEM_RUNNER_LINK } from '../runners/vocabulary.js';
import {
  pipelineRegistryService,
  PR_PIPELINE_NOT_OWNED,
  PR_REGISTRY_OWNED_BY_OTHER_ORG,
} from '../services/pipeline-registry-service.js';

/**
 * One step-manifest entry as the CLI ships it from the synth. Only
 * `pluginId` is used to resolve the plugin — name/version/digest are
 * re-read from that row server-side (see replaceStepManifest).
 */
export const StepManifestEntrySchema = z.object({
  stageName: z.string().min(1).max(255),
  actionName: z.string().min(1).max(255),
  pluginId: z.string().uuid(),
  pluginName: z.string().min(1).max(255),
  pluginVersion: z.string().min(1).max(50),
  imageDigest: z.string().max(71).nullable(),
  /** The step's key as synth sends it in lookup `context` — joins lookups and runtime checks to this row. */
  stepKey: z.string().max(255).optional(),
  /**
   * The build-image entry only (the sentinel (stage, action)): how synth chose
   * the toolchain release. Its release version is re-read from the plugin row.
   */
  resolvedVia: z.enum(TOOLCHAIN_RESOLVED_VIA).optional(),
});

/** Upper bound on manifest entries per registration (CodePipeline caps a pipeline far below this). */
export const MAX_MANIFEST_STEPS = 500;

const PipelineRegistrySchema = z.object({
  // The pipeline's row id (a uuid column): anything else would reach the
  // ownership lookup as a Postgres cast error and answer 500, not 400.
  pipelineId: z.string().uuid('pipelineId must be a pipeline UUID'),
  // Bounded by the registry columns: an over-long value is a 400, not a
  // Postgres "value too long" 500.
  pipelineName: z.string().min(1, 'pipelineName is required').max(255),
  region: z.string().max(30).optional(),
  project: z.string().max(255).optional(),
  organization: z.string().max(255).optional(),
  stackName: z.string().max(255).optional(),
  steps: z.array(StepManifestEntrySchema).max(MAX_MANIFEST_STEPS).optional(),
});

/** The Deployment card's `runner: { id, label } | null` on each row (the caller's own org only). */
async function withRunners<T extends { pipelineId: string }>(rows: T[], orgId: string, ownOrg: boolean): Promise<Array<T & { runner: { id: string; label: string } | null }>> {
  if (!ownOrg || rows.length === 0) return rows.map((r) => ({ ...r, runner: null }));
  const links = await runnerDeps().store.runnerLinks(rows.map((r) => r.pipelineId), orgId);
  return rows.map((r) => ({ ...r, runner: links.get(r.pipelineId) ?? null }));
}

/**
 * Register pipeline registry routes.
 * - POST /pipelines/registry — upsert a pipeline's deployment registration for event reporting,
 *   and (when `steps` is sent — a post-deploy registration) replace the
 *   pipeline's step manifest, which attributes action events to plugins.
 * - GET  /pipelines/registry — list registry entries owned by the caller's org.
 *   Used by the dashboard's "deployed pipelines" panel and by drift-detection
 *   tools (the `pipeline-manager audit stacks` CLI joins this against live
 *   CloudFormation stacks tagged `pipeline-builder` to surface orphans).
 *   Query: `limit` (default 10, max MAX_PAGE_LIMIT) + `offset` page the list —
 *   a caller pages until `pagination.hasMore` is false; the order is
 *   `lastDeployed DESC, id ASC`, total and stable. `orgId` names the org to list:
 *   omitted or equal to the caller's org lists the caller's own rows; any OTHER
 *   org is honoured only for a system admin (cross-org drift audits from the
 *   system org) and answers 403 for everyone else, so a tenant cannot read
 *   another org's deployments by guessing an id.
 */
export function createRegistryRoutes(): Router {
  const router = Router();

  // The org the list reads is resolved per request (?orgId=), so the rule is declared.
  const registryReadAuthz = dynamicAuthz(
    'the caller\'s own org; another org named by ?orgId= only for the superadmin flag',
    { reachableBy: ['tenant-member', 'superadmin'] },
  );

  router.get('/registry', requirePermission('pipelines:read'), registryReadAuthz, withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query as Record<string, unknown>);
    const requested = typeof req.query.orgId === 'string' ? req.query.orgId.trim().toLowerCase() : '';
    const targetOrgId = requested || orgId;
    if (targetOrgId !== orgId && !isSystemAdmin(req)) {
      return sendError(res, 403, 'Only a system admin may list another organization\'s registry.', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }
    const { rows, total } = await pipelineRegistryService.list(targetOrgId, limit, offset);
    ctx.log('COMPLETED', 'Listed pipeline registry', { count: rows.length, ...(targetOrgId !== orgId && { targetOrgId }) });
    return sendPaginatedNested(res, 'registry', await withRunners(rows, targetOrgId, targetOrgId === orgId), {
      total, limit, offset,
    });
  }));

  router.post('/registry', requirePermission('pipeline_registry:write'), audited('pipeline.registry.register'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, PipelineRegistrySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const v = validation.value;
    // No ARN/account is stored: the events Lambda resolves the pipeline's
    // `pb.pipeline-id` tag (= pipelineId) and reports against it, so the
    // registry only needs the stable pipelineId + display metadata.
    ctx.log('INFO', 'Registering pipeline for event reporting', { pipelineId: v.pipelineId });

    try {
      const { exposures, ...result } = await pipelineRegistryService.upsert({
        pipelineId: v.pipelineId,
        orgId,
        pipelineName: v.pipelineName,
        region: v.region,
        project: v.project,
        organization: v.organization,
        stackName: v.stackName,
        steps: v.steps,
        ...(req.user?.parentOrganizationId ? { parentOrgId: req.user.parentOrganizationId } : {}),
      });
      ctx.log('COMPLETED', 'Pipeline registered', { id: result.id, pipelineId: v.pipelineId, manifestSteps: result.manifestSteps });
      if (result.pipelineDeleted) {
        ctx.log('WARN', 'Registered a deployment of a soft-deleted pipeline (the stack outlived its config)', { pipelineId: v.pipelineId });
      }

      // Best-effort attributed audit — emitted only after the mapping landed.
      // `targetId` is the stable pipeline id. `details` carries display metadata
      // ONLY — never the CodePipeline ARN, which embeds the AWS account id.
      recordAudit({
        action: 'pipeline.registry.register',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'pipeline',
        targetId: v.pipelineId,
        details: {
          registryId: result.id,
          pipelineName: v.pipelineName,
          ...(v.region !== undefined ? { region: v.region } : {}),
          ...(v.project !== undefined ? { project: v.project } : {}),
          ...(v.organization !== undefined ? { organization: v.organization } : {}),
          ...(v.stackName !== undefined ? { stackName: v.stackName } : {}),
          ...(result.manifestSteps !== undefined ? { manifestSteps: result.manifestSteps } : {}),
          ...(result.pipelineDeleted ? { pipelineDeleted: true } : {}),
          // Deployed-side plugin vulnerability exposures the manifest reconcile
          // opened / closed (only when a manifest was sent).
          ...(exposures ? { exposuresOpened: exposures.opened, exposuresClosed: exposures.closed } : {}),
        },
      });

      // Link at registration: probe the org's runners in the background and
      // save the link, so the first Run goes straight to its runner. Never
      // awaited, never fails the registration; its outcome is the row's
      // runner-link status (and Run still falls back to discovery).
      void linkInBackground(runnerDeps(), {
        pipelineId: v.pipelineId,
        orgId,
        requestedBy: SYSTEM_RUNNER_LINK,
        ...(req.user?.parentOrganizationId ? { parentOrgId: req.user.parentOrganizationId } : {}),
      });

      return sendSuccess(res, 200, { registry: result });
    } catch (err) {
      const code = errorMessage(err);
      if (code === PR_PIPELINE_NOT_OWNED) {
        return sendError(res, 404, 'Pipeline not found in your organization', ErrorCode.NOT_FOUND);
      }
      if (code === PR_REGISTRY_OWNED_BY_OTHER_ORG) {
        ctx.log('WARN', 'Rejected registry claim for a pipeline owned by another org', { pipelineId: v.pipelineId });
        return sendError(res, 409, 'Pipeline is registered to a different organization', ErrorCode.CONFLICT);
      }
      // Unexpected DB error: a generic message. The sanitized DB metadata
      // (code/constraint/table names) stays in the log, correlated by requestId,
      // as on create — schema names are not the caller's to read.
      ctx.log('ERROR', 'Pipeline registration failed', { pipelineId: v.pipelineId, db: extractDbError(err) });
      return sendError(res, 500, 'Failed to register pipeline', ErrorCode.DATABASE_ERROR);
    }
  }));

  /**
   * DELETE /pipelines/registry/:id — remove a single registry row by its UUID.
   *
   * Used to reconcile drift after a CloudFormation stack is deleted out-of-band
   * (i.e. without `pipeline-manager pipeline deploy`), which leaves a stale registry row.
   * The `pipeline-manager audit stacks` CLI surfaces such rows; this endpoint is
   * the supported path to clear them.
   *
   * Tenancy: scoped to the caller's orgId. A 404 is returned for both
   * "row does not exist" and "row exists but belongs to another org" so a
   * caller cannot probe other orgs' registry contents.
   *
   * Note: this is a hard delete, not a soft delete. The registry table is a
   * pure mapping cache — losing a row never loses information that isn't
   * already in CloudFormation, so there's nothing to recover.
   */
  router.delete('/registry/:id', requirePermission('pipeline_registry:write'), audited('pipeline.registry.deregister'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Registry id is required.', ErrorCode.MISSING_REQUIRED_FIELD);
    // The row id is a uuid column: a malformed one names no row (404, like an
    // absent one) instead of failing the delete with a Postgres cast error (500).
    if (!z.string().uuid().safeParse(id).success) return sendError(res, 404, 'Registry entry not found.', ErrorCode.NOT_FOUND);

    const deleted = await pipelineRegistryService.delete(id, orgId);
    if (!deleted) return sendError(res, 404, 'Registry entry not found.', ErrorCode.NOT_FOUND);

    ctx.log('COMPLETED', 'Pipeline registry row deleted', { id: deleted.id, pipelineId: deleted.pipelineId });

    // Best-effort attributed audit — emitted only after the row was removed.
    // `targetId` is the stable pipeline id; `details` carries the registry row
    // handle (UUID) only — never the CodePipeline ARN / AWS account id.
    recordAudit({
      action: 'pipeline.registry.deregister',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'pipeline',
      targetId: deleted.pipelineId,
      details: { registryId: deleted.id, exposuresClosed: deleted.exposuresClosed },
    });

    return sendSuccess(res, 200, { id: deleted.id });
  }));

  return router;
}
