// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  sendError,
  sendEntityNotFound,
  ErrorCode,
  logAuditEvent,
  audited,
  requireAllPermissions,
  validateBody,
} from '@pipeline-builder/api-core';
import { withRoute, incCounter } from '@pipeline-builder/api-server';
import { type Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { canReadRepo, canWriteRepo } from './repo-access.js';
import { logger, recordRegistryAudit, RegistryMetrics } from './shared.js';
import { copyManifestTree, InvalidManifestError, SourceIncompleteError } from '../../services/manifest-copy.js';
import { inSystemNamespace, repoOwnerOrgId, repoTenant } from '../../services/namespaces.js';
import {
  getManifest,
  headManifest,
  isNotFound,
} from '../../services/registry-client.js';

const CopyImageSchema = z.object({
  source: z.string().regex(/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_.-]+$/, 'Invalid source — expected "<repo>:<ref>"'),
  target: z.string().regex(/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_.-]+$/, 'Invalid target — expected "<repo>:<ref>"'),
  overwrite: z.boolean().optional().default(false),
  /** Required when source/target live in different `org-*` tenants. */
  allowCrossTenant: z.boolean().optional().default(false),
});

/**
 * Split a `<repo>:<ref>` string into its components. Repo paths can
 * contain `/` (`org-acme/foo`), so we split on the LAST colon — not naive
 * `split(':')`. The Zod regex guarantees exactly one `:` in the valid
 * input, but this function is robust to that contract.
 */
function parseRepoRef(s: string): { repo: string; ref: string } {
  const i = s.lastIndexOf(':');
  return { repo: s.slice(0, i), ref: s.slice(i + 1) };
}

/**
 * Register the copy route:
 *  - POST /copy (cross-repo tag-copy; multi-arch aware)
 *
 * Copy inherently reads the source and writes the target, so it requires BOTH
 * `registry:read` AND `registry:write` (via `requireAllPermissions`).
 */
export function registerCopyRoutes(router: Router): void {
  // POST /api/images/copy — cross-repo tag-copy, multi-arch aware.
  router.post('/copy', requireAllPermissions('registry:read', 'registry:write') as RequestHandler, audited('registry.image.copy'), withRoute(async ({ req, res, ctx, userId }) => {
    const validation = validateBody(req, CopyImageSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const { source, target, overwrite, allowCrossTenant } = validation.value;

    if (source === target) {
      return sendError(
        res, 400,
        'Source and target are identical.',
        ErrorCode.VALIDATION_ERROR,
        { reason: 'source-equals-target' },
      );
    }

    const { repo: sourceRepo, ref: sourceRef } = parseRepoRef(source);
    const { repo: targetRepo, ref: targetRef } = parseRepoRef(target);

    // Per-repo org-ownership gate (independent of the registry:read/write perm).
    // Copy READS the source and WRITES the target, so the caller must own (or be
    // superadmin for) BOTH. This is the tenant boundary — it holds even if
    // registry:* is later wired to an org role, so a copy can't be used to read
    // or poison another tenant's repos.
    if (!canReadRepo(req.user, sourceRepo)) {
      return sendError(
        res, 403,
        `Forbidden: source repo "${sourceRepo}" is outside your organization.`,
        ErrorCode.ORG_MISMATCH,
        { reason: 'repo-not-owned', repo: sourceRepo, access: 'read' },
      );
    }
    if (!canWriteRepo(req.user, targetRepo)) {
      return sendError(
        res, 403,
        `Forbidden: target repo "${targetRepo}" is outside your organization.`,
        ErrorCode.ORG_MISMATCH,
        { reason: 'repo-not-owned', repo: targetRepo, access: 'write' },
      );
    }

    // Cross-tenant guard: copying between two distinct `org-*` namespaces
    // moves data across customer boundaries. Require an explicit opt-in so
    // operators can't do it by accident. Promotions to `system/` or copies
    // within the same org continue to work without the flag.
    const sourceTenant = repoTenant(sourceRepo);
    const targetTenant = repoTenant(targetRepo);
    if (
      sourceTenant !== null &&
      targetTenant !== null &&
      sourceTenant !== targetTenant &&
      !allowCrossTenant
    ) {
      return sendError(
        res, 400,
        'Cross-tenant copy requires "allowCrossTenant: true" in the request body.',
        ErrorCode.VALIDATION_ERROR,
        { reason: 'cross-tenant-not-allowed', sourceTenant, targetTenant },
      );
    }

    // Resolve source manifest.
    let sourceManifest;
    try {
      sourceManifest = await getManifest(sourceRepo, sourceRef);
    } catch (err) {
      if (isNotFound(err)) return sendEntityNotFound(res, 'Source manifest');
      throw err;
    }

    // Overwrite guard.
    if (!overwrite) {
      const existing = await headManifest(targetRepo, targetRef);
      if (existing && existing.digest !== sourceManifest.digest) {
        return sendError(
          res, 409,
          'Target tag already exists with a different digest.',
          ErrorCode.CONFLICT,
          {
            reason: 'target-exists',
            existing: { ref: target, digest: existing.digest },
            requested: { digest: sourceManifest.digest },
          },
        );
      }
    }

    // Copy.
    let mountedBlobs: number;
    let mountedManifests: number;
    try {
      const counts = await copyManifestTree(sourceManifest, sourceRepo, targetRepo, targetRef);
      mountedBlobs = counts.blobs;
      mountedManifests = counts.manifests;
    } catch (err) {
      // A copy that throws mid-tree may have already mounted some blobs / PUT
      // some child manifests — those are now orphaned in the target repo (the
      // registry's own GC eventually reclaims unreferenced blobs). Emit a
      // partial-failure metric so operators can spot copies that need a rerun
      // (idempotent) or cleanup, regardless of which failure class it was.
      incCounter(RegistryMetrics.TAG_COPY_PARTIAL);
      if (err instanceof SourceIncompleteError) {
        return sendError(
          res, 409,
          err.message,
          ErrorCode.CONFLICT,
          { reason: 'source-incomplete', missingDigest: err.missingDigest },
        );
      }
      if (err instanceof InvalidManifestError) {
        return sendError(
          res, 400,
          err.message,
          ErrorCode.VALIDATION_ERROR,
          { reason: 'invalid-manifest' },
        );
      }
      throw err;
    }

    ctx.log('COMPLETED', 'Copied manifest', {
      source,
      target,
      sourceDigest: sourceManifest.digest,
      mountedManifests,
      mountedBlobs,
    });

    // The operator-facing Loki line; `recordRegistryAudit` below is its durable
    // twin (see that helper for why both exist). A cross-tenant copy moves data
    // across customer boundaries, so it MUST land in the durable trail too.
    logAuditEvent(logger, {
      event: 'registry.tag.copy',
      actor: req.user?.sub ?? 'unknown',
      source,
      target,
      sourceDigest: sourceManifest.digest,
      targetDigest: sourceManifest.digest,
      isPromotionToSystem: inSystemNamespace(targetRepo),
      mounted: { manifests: mountedManifests, blobs: mountedBlobs },
    });
    // `crossTenant` records the tenant boundary crossing, so cross-org promotions
    // stay auditable long after the request logs lapse. Details carry no secrets
    // / AWS account ids. The owning org here is the TARGET's (the namespace that
    // was written).
    recordRegistryAudit(req, userId, {
      action: 'registry.image.copy',
      ownerOrgId: repoOwnerOrgId(targetRepo),
      targetId: target,
      details: {
        source,
        target,
        sourceDigest: sourceManifest.digest,
        crossTenant: sourceTenant !== null && targetTenant !== null && sourceTenant !== targetTenant,
        isPromotionToSystem: inSystemNamespace(targetRepo),
        mountedManifests,
        mountedBlobs,
      },
    });
    // Two counters: total copies + a separate counter for system-promotions
    // so the dashboard can show promotion velocity without dividing series.
    incCounter(RegistryMetrics.TAG_COPY);
    if (inSystemNamespace(targetRepo)) {
      incCounter(RegistryMetrics.TAG_PROMOTE);
    }

    return sendSuccess(res, 200, {
      source,
      target,
      digest: sourceManifest.digest,
      mounted: { manifests: mountedManifests, blobs: mountedBlobs },
    });
  }));
}
