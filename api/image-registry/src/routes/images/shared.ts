// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { actorId, createLogger, ErrorCode, recordAudit, recordAuthzDenial, sendError, SYSTEM_ORG_ID, type Logger, type RemoteAuditEvent } from '@pipeline-builder/api-core';
import type { Response, Request } from 'express';

export const logger: Logger = createLogger('image-routes');

/** Symbolic metric names so all incCounter call-sites stay in sync. */
export const RegistryMetrics = {
  TAG_DELETE: 'registry_tag_delete_total',
  TAG_COPY: 'registry_tag_copy_total',
  /** A copy that threw mid-tree (may have left orphan blobs in the target). */
  TAG_COPY_PARTIAL: 'registry_tag_copy_partial_failure_total',
  TAG_PROMOTE: 'registry_tag_promote_total',
  REPO_DELETE: 'registry_repo_delete_total',
} as const;

/**
 * The durable audit row for a registry mutation (the tamper-evident Mongo
 * hash-chain trail).
 *
 * Every registry write ALSO emits a Loki line through `logAuditEvent`. That
 * dual emit is intentional, NOT an accidental duplication: the Loki line feeds
 * the operator Audit-Activity dashboard / RecentActionsPanel — a
 * short-retention, human-facing ops view — while this row is the durable
 * compliance record. Keep both.
 *
 * `affectedOrgId` is the org that OWNS the repository being written, so its
 * admins see the event even when a superadmin performed it; it is absent for
 * org-less namespaces (`library/*`). Fire-and-forget — `recordAudit` never
 * blocks or throws — and every caller emits only AFTER the registry write has
 * landed, so a failed delete/copy leaves no success row.
 */
export function recordRegistryAudit(req: Request, userId: string, entry: {
  action: RemoteAuditEvent['action'];
  /** The repository's owning org; absent for an org-less namespace (`library/*`). */
  ownerOrgId: string | null | undefined;
  targetId: string;
  details: Record<string, unknown>;
  /**
   * 'failure' for a write that died PART-WAY (a copy that mounted some blobs, a
   * repo prune that deleted some manifests) — something changed, so it is on
   * the trail, flagged so a reviewer doesn't read it as a completed action.
   */
  outcome?: 'success' | 'failure';
}): void {
  recordAudit({
    action: entry.action,
    actorId: actorId({ userId }),
    ...(req.user?.email && { actorEmail: req.user.email }),
    // The caller's org; a principal with none is the system acting (never
    // org-less — the ingest refuses an event without an org).
    orgId: req.user?.organizationId || SYSTEM_ORG_ID,
    ...(entry.ownerOrgId && { affectedOrgId: entry.ownerOrgId }),
    outcome: entry.outcome ?? 'success',
    targetType: 'registry-image',
    targetId: entry.targetId,
    details: entry.details,
  });
}

/**
 * Refuse a repository outside the caller's org (403 ORG_MISMATCH) and put the
 * attempt on the `authz.denied` trail — a cross-tenant write probe returns an
 * error and otherwise leaves nothing behind. (`recordAuthzDenial` skips
 * GET/HEAD, so read-side probes stay out of the trail by design.)
 */
export function denyRepoNotOwned(req: Request, res: Response, repo: string, access: 'read' | 'write', label = 'repo'): void {
  recordAuthzDenial(req, `registry:${access} on ${repo} (repo-not-owned)`);
  sendError(res, 403, `Forbidden: ${label} "${repo}" is outside your organization.`, ErrorCode.ORG_MISMATCH, { reason: 'repo-not-owned', repo, access });
}
