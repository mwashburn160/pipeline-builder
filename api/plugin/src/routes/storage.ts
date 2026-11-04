// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An organization's registry-storage view, and the one action that can free it.
 *
 * `storageBytes` was the only quota a tenant could not act on: GC is off by
 * default, manual GC is superadmin-only, and deleting a plugin version left its
 * registry manifests behind. So "you are at 95% of your storage" could only ever
 * be followed by "buy capacity or contact support". These two routes are the
 * missing remedy.
 *
 * GATES. Reading is `plugins:read`; pruning is `plugins:write`, which already
 * means "Create, upload, edit, and delete plugins" — retiring a version's image
 * is squarely inside it, so no new permission is introduced. The destructive
 * registry primitive stays where it was: the tenant route asks the registry's
 * own confined endpoint, which refuses anything outside the caller's namespace,
 * and `registry:purge` (superadmin + aal2) remains the operator's path for
 * everything else.
 */

import { actorId, audited, recordAudit, requirePermission, sendError, sendSuccess, ErrorCode, formatQuotaAmount } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { pruneVersion, reclaimPlan } from '../services/storage-reclaim.js';

const pruneSchema = z.object({
  repo: z.string().min(1).max(255),
  tag: z.string().min(1).max(128),
});

/** Why a refusal is the user's answer, not an error. */
const REFUSAL: Record<string, { status: number; message: string }> = {
  in_use: {
    status: 409,
    message: 'A pipeline still references this version. Update the pipeline to a newer version first — nothing is deleted while a deployed pipeline depends on it.',
  },
  published: {
    status: 409,
    message: 'This is a published copy. Its bytes stay billed to the publisher until the listing is unlisted or withdrawn, so deleting it here would free nothing.',
  },
  unknown_version: {
    status: 404,
    message: 'No plugin version of yours matches that image.',
  },
  registry_unavailable: {
    status: 503,
    message: 'Your storage could not be read just now, so nothing was deleted. Try again shortly.',
  },
};

export function createStorageRoutes(): Router {
  const router = Router();

  /**
   * What this organization's storage is spent on, and what it can reclaim.
   *
   * 503 rather than an empty plan when the registry cannot answer: an empty
   * list would read as "nothing to free", which is the opposite of the truth
   * and the worse failure for someone who is out of space.
   */
  router.get('/storage', requirePermission('plugins:read') as RequestHandler, withRoute(async ({ res, ctx, orgId }) => {
    const plan = await reclaimPlan(orgId);
    if (!plan) {
      return sendError(res, 503, REFUSAL.registry_unavailable!.message, ErrorCode.SERVICE_UNAVAILABLE);
    }
    ctx.log('COMPLETED', 'Read storage reclaim plan', {
      orgId, bytes: plan.bytes, candidates: plan.candidates.length, incomplete: plan.incomplete,
    });
    return sendSuccess(res, 200, {
      ...plan,
      // Said once, here, so every surface words the headline figures alike.
      usedLabel: formatQuotaAmount('storageBytes', plan.bytes),
      reclaimableLabel: formatQuotaAmount('storageBytes', plan.reclaimableBytes),
    });
  }));

  /**
   * Retire one version's image so its layers leave the storage total.
   *
   * Eligibility is re-checked inside `pruneVersion` against a fresh reading,
   * not taken from the request: the caller's figures may be a minute old, and a
   * pipeline could have started referencing the version in that minute.
   */
  router.post(
    '/storage/prune',
    requirePermission('plugins:write') as RequestHandler,
    // ONE declared action. A refusal is recorded below as the same action with
    // `outcome: 'failure'`, so a separate `…_refused` declaration would name an
    // action nothing ever emits — the mistake the audit-action list already
    // carries a tombstone for.
    audited('plugin.version.prune') as RequestHandler,
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const parsed = pruneSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(res, 400, 'repo and tag are required', ErrorCode.VALIDATION_ERROR);
      }
      const { repo, tag } = parsed.data;
      const outcome = await pruneVersion(orgId, repo, tag);
      if (!outcome.pruned) {
        const refusal = REFUSAL[outcome.reason ?? 'unknown_version'] ?? REFUSAL.unknown_version!;
        // The refusal is audited as a failed prune, naming the reason: "why
        // can't I free this space?" is exactly what gets asked afterwards.
        recordAudit({
          action: 'plugin.version.prune',
          actorId: actorId({ userId }),
          orgId,
          affectedOrgId: orgId,
          outcome: 'failure',
          targetType: 'plugin-version',
          targetId: `${repo}:${tag}`,
          details: { repo, tag, refusal: outcome.reason },
        });
        return sendError(res, refusal.status, refusal.message, ErrorCode.VALIDATION_ERROR);
      }
      ctx.log('COMPLETED', 'Pruned a version to reclaim storage', { orgId, repo, tag, freedBytes: outcome.freedBytes });
      recordAudit({
        action: 'plugin.version.prune',
        actorId: actorId({ userId }),
        orgId,
        affectedOrgId: orgId,
        outcome: 'success',
        targetType: 'plugin-version',
        targetId: `${repo}:${tag}`,
        // The byte figure is recorded because it is the whole point of the
        // action and cannot be recovered afterwards — once the tag is gone, the
        // marginal size it used to carry is unknowable.
        details: { repo, tag, freedBytes: outcome.freedBytes },
      });
      return sendSuccess(res, 200, {
        ...outcome,
        freedLabel: formatQuotaAmount('storageBytes', outcome.freedBytes),
      });
    }),
  );

  return router;
}
