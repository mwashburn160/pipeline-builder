// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { loadAndPurge, sendSuccess, sendError, audited, actorId, recordAudit, getParam, ErrorCode } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { pipelineRegistryService } from '../services/pipeline-registry-service.js';
import { pipelineService, withClosedExposureTally } from '../services/pipeline-service.js';

/**
 * Register the PURGE route on a router — permanently hard-delete a soft-deleted
 * pipeline tombstone on demand (the manual counterpart to the retention sweep,
 * which would remove it later once `purge_after` passes).
 *
 * Expects `requireAuth`, `requireOrgId`, `requirePermission('pipelines:write')`
 * and `requireStepUp` to have been applied as router-level middleware in the
 * parent (mirrors the restore authority — delete's write-gate plus a step-up
 * re-verify, since purge is a permanent destructive action). This router shares
 * the restore router's single step-up-gated mount so the single-use step-up jti
 * is consumed exactly once per request (see src/app-routes.ts). The load →
 * publish-gate → hard-delete → 404 skeleton is shared via `loadAndPurge`, which
 * loads only a genuine tombstone (a live row 404s and is never hard-deleted).
 */
export function createPurgePipelineRoutes(): Router {
  const router: Router = Router();

  router.post('/:id/purge', audited('pipeline.purge'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    // A pipeline with a REGISTRATION may still have a running stack: purging it
    // would orphan that stack (its next registration is refused — the row is
    // gone — and its events stop attributing). The registry row is the only
    // deployment signal the platform has (no stack-status probe), so a purge
    // with one is refused unless the caller says the stack is gone: `?force=true`,
    // recorded on the audit event. The forced purge drops the registration too.
    const id = getParam(req.params, 'id');
    const force = req.query.force === 'true';
    // The registration lookup is elevated (by pipeline id alone), so it runs
    // only once the id names a tombstone in the caller's own scope — otherwise
    // the 409 below would hand another org's stack name and region to anyone
    // who guessed an id. An unknown id falls through to loadAndPurge's 404.
    const tombstone = id ? await pipelineService.findDeletedById(id, orgId) : null;
    const deployment = id && tombstone ? await pipelineRegistryService.deploymentOf(id) : null;
    if (deployment && !force) {
      ctx.log('WARN', 'Purge refused: pipeline still registered as deployed', { id, stackName: deployment.stackName });
      return sendError(res, 409,
        `Pipeline is still registered as deployed${deployment.stackName ? ` (stack ${deployment.stackName}${deployment.region ? `, ${deployment.region}` : ''})` : ''}. `
        + 'Delete the stack and deregister it (DELETE /pipelines/registry/:id), or purge with ?force=true if the stack is already gone.',
        ErrorCode.CONFLICT, { registryId: deployment.registryId, stackName: deployment.stackName, region: deployment.region });
    }

    const { result, exposuresClosed } = await withClosedExposureTally(() => loadAndPurge(req, res, pipelineService, { orgId, userId, label: 'Pipeline', publishPermission: 'pipelines:publish' }));
    if (!result) return;
    const { existing, purgedId } = result;

    ctx.log('COMPLETED', 'Purged pipeline', { id: purgedId, name: existing.pipelineName, forced: Boolean(deployment) });

    // Best-effort attributed audit — `affectedOrgId` records the target's org so
    // a no-org sysadmin purge is attributed to the org whose row was removed.
    recordAudit({
      action: 'pipeline.purge',
      actorId: actorId({ userId }),
      orgId,
      affectedOrgId: existing.orgId,
      targetType: 'pipeline',
      targetId: purgedId,
      details: {
        pipelineName: existing.pipelineName,
        visibility: existing.visibility,
        // Every remaining (declared + deployed) plugin vulnerability exposure the purge closed.
        exposuresClosed,
        ...(deployment ? { forced: true, deregistered: { registryId: deployment.registryId, stackName: deployment.stackName } } : {}),
      },
    });

    return sendSuccess(res, 200, {}, 'Pipeline permanently deleted.');
  }));

  return router;
}
