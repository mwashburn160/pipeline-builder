// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, audited, loadAndRestore, requirePermission, requireStepUp, actorId, recordAudit } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';

/** Minimal surface a restorable compliance entity's service must expose. */
interface RestorableService {
  findDeletedById(id: string, orgId?: string): Promise<{ orgId: string; name: string } | null>;
  restore(id: string, orgId: string, userId: string): Promise<{ orgId: string; name: string } | null>;
}

/**
 * Shared `POST /:id/restore` route for compliance rules + policies — undo a
 * soft-delete within the retention window. The route owns its full chain,
 * `compliance:write` then `requireStepUp` (the `/compliance/{rules,policies}`
 * mount supplies only auth + orgId + quota), matching the pipeline restore's
 * "re-verify before reversing a destructive action". Compliance entities carry
 * no visibility ladder, so `compliance:write` is the whole authority. The
 * service's `onAfterRestore` hook re-invalidates caches + rescans so a restored
 * entity re-enters evaluation.
 */
export function createComplianceRestoreRoutes(opts: {
  service: RestorableService;
  label: string; // 'Rule' | 'Policy' — user-facing entity noun
  action: 'compliance.rule.restore' | 'compliance.policy.restore';
  targetType: 'rule' | 'policy';
}): Router {
  const { service, label, action, targetType } = opts;
  const router = Router();

  router.post('/:id/restore', requirePermission('compliance:write'), requireStepUp, audited(action), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const result = await loadAndRestore(req, res, service, { orgId, userId, label, authorize: () => true });
    if (!result) return;
    const { existing, restored } = result;

    ctx.log('COMPLETED', `Restored compliance ${targetType}`, { id: req.params.id, name: restored.name });

    recordAudit({
      action,
      actorId: actorId({ userId }),
      orgId,
      affectedOrgId: existing.orgId,
      targetType,
      targetId: String(req.params.id),
      details: { name: restored.name },
    });

    return sendSuccess(res, 200, undefined, `${label} restored`);
  }));

  return router;
}
