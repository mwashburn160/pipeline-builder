// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendEntityNotFound, ErrorCode, getParam, requireStepUp } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { emitComplianceAudit } from '../services/remote-audit-client.js';

/** Minimal surface a purgeable compliance entity's service must expose. */
interface PurgeableService {
  findDeletedById(id: string, orgId: string): Promise<{ orgId: string; name: string } | null>;
  purgeById(id: string, orgId: string): Promise<string | null>;
}

/**
 * Shared `POST /:id/purge` route for compliance rules + policies — the manual,
 * on-demand hard-delete of a soft-deleted tombstone, finalizing an already-
 * soft-deleted item ahead of the retention sweep. It reuses the sweep's
 * `purgeById` (same `onBeforePurge`/`onAfterPurge` teardown) to destroy the
 * tombstone permanently.
 *
 * Like restore, this route adds `requireStepUp` (password re-verify) on the
 * route itself — the composite `/compliance/{rules,policies}` chain supplies
 * auth + orgId + `compliance:write`, not step-up. Purge is an irreversible
 * hard-delete, so it re-verifies before destroying the tombstone, matching the
 * restore route's "re-verify before a destructive action". The frontend sends
 * the step-up token in the same header restore uses.
 *
 * Mirrors {@link createComplianceRestoreRoutes}: load the own-org tombstone for
 * access-control gating (and to capture name/orgId for the audit record), then
 * hard-delete it, emitting an attributed `compliance.{rule,policy}.purge` event
 * only after the purge succeeds.
 */
export function createCompliancePurgeRoutes(opts: {
  service: PurgeableService;
  label: string; // 'Rule' | 'Policy' — user-facing entity noun
  action: 'compliance.rule.purge' | 'compliance.policy.purge';
  targetType: 'rule' | 'policy';
}): Router {
  const { service, label, action, targetType } = opts;
  const router = Router();

  router.post('/:id/purge', requireStepUp, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, `${label} ID is required`, ErrorCode.MISSING_REQUIRED_FIELD);

    // Load the tombstone first: gates on own-org scope + genuine soft-delete
    // (404 otherwise) and captures name/orgId for the audit record before the row
    // is destroyed.
    const existing = await service.findDeletedById(id, orgId);
    if (!existing) return sendEntityNotFound(res, label);

    const purgedId = await service.purgeById(id, orgId);
    if (!purgedId) return sendEntityNotFound(res, label);

    ctx.log('COMPLETED', `Purged compliance ${targetType}`, { id, name: existing.name });

    emitComplianceAudit({
      action,
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      affectedOrgId: existing.orgId,
      targetType,
      targetId: id,
      details: { name: existing.name },
    });

    return sendSuccess(res, 200, {}, `${label} permanently deleted.`);
  }));

  return router;
}
