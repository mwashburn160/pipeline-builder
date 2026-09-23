// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { actorId, createLogger, recordAudit, type Logger, type RemoteAuditEvent } from '@pipeline-builder/api-core';
import type { Request } from 'express';

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
}): void {
  recordAudit({
    action: entry.action,
    actorId: actorId({ userId }),
    ...(req.user?.email && { actorEmail: req.user.email }),
    ...(req.user?.organizationId && { orgId: req.user.organizationId }),
    ...(entry.ownerOrgId && { affectedOrgId: entry.ownerOrgId }),
    outcome: 'success',
    targetType: 'registry-image',
    targetId: entry.targetId,
    details: entry.details,
  });
}
