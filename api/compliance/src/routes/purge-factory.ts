// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, audited, loadAndPurge, requirePermission, requireStepUp, actorId, recordAudit } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';

/** Minimal surface a purgeable compliance entity's service must expose. */
interface PurgeableService {
  findDeletedById(id: string, orgId?: string): Promise<{ orgId: string; name: string } | null>;
  purgeById(id: string, orgId?: string): Promise<string | null>;
}

/**
 * Shared `POST /:id/purge` route for compliance rules + policies — the manual,
 * on-demand hard-delete of a soft-deleted tombstone ahead of the retention
 * sweep, reusing the sweep's `purgeById` (same `onBeforePurge`/`onAfterPurge`
 * teardown).
 *
 * Like restore, this route owns its full authorization chain —
 * `compliance:write` then `requireStepUp` (password re-verify) — rather than
 * inheriting a gate from the `/compliance/{rules,policies}` mount, which
 * supplies only auth + orgId + quota. Purge is irreversible, so it re-verifies
 * before destroying the tombstone. The tombstone is loaded first (own-org, 404
 * otherwise) so name/orgId survive for the audit record, emitted only after
 * the purge succeeds.
 */
export function createCompliancePurgeRoutes(opts: {
  service: PurgeableService;
  label: string; // 'Rule' | 'Policy' — user-facing entity noun
  action: 'compliance.rule.purge' | 'compliance.policy.purge';
  targetType: 'rule' | 'policy';
}): Router {
  const { service, label, action, targetType } = opts;
  const router = Router();

  router.post('/:id/purge', requirePermission('compliance:write'), requireStepUp, audited(action), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const result = await loadAndPurge(req, res, service, { orgId, userId, label, authorize: () => true });
    if (!result) return;
    const { existing, purgedId } = result;

    ctx.log('COMPLETED', `Purged compliance ${targetType}`, { id: purgedId, name: existing.name });

    recordAudit({
      action,
      actorId: actorId({ userId }),
      orgId,
      affectedOrgId: existing.orgId,
      targetType,
      targetId: purgedId,
      details: { name: existing.name },
    });

    return sendSuccess(res, 200, {}, `${label} permanently deleted.`);
  }));

  return router;
}
