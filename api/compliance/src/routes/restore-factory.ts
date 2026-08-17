// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendEntityNotFound, ErrorCode, getParam, requireStepUp } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { emitComplianceAudit } from '../services/remote-audit-client.js';

/** Minimal surface a restorable compliance entity's service must expose. */
interface RestorableService {
  findDeletedById(id: string, orgId: string): Promise<{ orgId: string; name: string } | null>;
  restore(id: string, orgId: string, userId: string): Promise<{ name: string } | null>;
}

/**
 * Shared `POST /:id/restore` route for compliance rules + policies — undo a
 * soft-delete within the retention window. `requireStepUp` is on the route (the
 * composite `/compliance/{rules,policies}` router supplies auth + orgId +
 * `compliance:write`, not step-up), matching the pipeline restore's "re-verify
 * before reversing a destructive action". The service's `onAfterRestore` hook
 * re-invalidates caches + rescans so a restored entity re-enters evaluation.
 *
 * The rule and policy restore routes were byte-identical apart from the service,
 * label, audit action, and targetType — this collapses them into one factory.
 */
export function createComplianceRestoreRoutes(opts: {
  service: RestorableService;
  label: string; // 'Rule' | 'Policy' — user-facing entity noun
  action: 'compliance.rule.restore' | 'compliance.policy.restore';
  targetType: 'rule' | 'policy';
}): Router {
  const { service, label, action, targetType } = opts;
  const router = Router();

  router.post('/:id/restore', requireStepUp, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, `${label} ID is required`, ErrorCode.MISSING_REQUIRED_FIELD);

    const existing = await service.findDeletedById(id, orgId);
    if (!existing) return sendEntityNotFound(res, label);

    const restored = await service.restore(id, orgId, userId);
    if (!restored) return sendEntityNotFound(res, label);

    ctx.log('COMPLETED', `Restored compliance ${targetType}`, { id, name: restored.name });

    emitComplianceAudit({
      action,
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      affectedOrgId: existing.orgId,
      targetType,
      targetId: id,
      details: { name: restored.name },
    });

    return sendSuccess(res, 200, undefined, `${label} restored`);
  }));

  return router;
}
