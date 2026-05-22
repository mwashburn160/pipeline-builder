// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { Request } from 'express';
import AuditEvent, { AuditAction } from '../models/audit-event';

const logger = createLogger('audit');

/**
 * Record an audit event (fire-and-forget — never blocks the request).
 *
 * @param req - Express request (used to extract actor and IP)
 * @param action - Audit action identifier
 * @param options - Optional target, details, and `affectedOrgId` for
 *                  cross-tenant operations
 *
 * Pass `affectedOrgId` whenever the action touches an org that is NOT the
 * actor's own (e.g. a sysadmin acting on org X's user/data). When omitted,
 * it defaults to the actor's `orgId`, so normal in-org operations don't have
 * to repeat the boilerplate.
 */
export function audit(
  req: Request,
  action: AuditAction,
  options: {
    targetType?: string;
    targetId?: string;
    details?: Record<string, unknown>;
    /** Override when the action affects a different org than the actor's
     *  (sysadmin acting on another org). Defaults to the actor's own org. */
    affectedOrgId?: string;
  } = {},
): void {
  const actorOrgId = req.user?.organizationId;
  const event = {
    action,
    actorId: req.user?.sub || 'anonymous',
    actorEmail: req.user?.email,
    orgId: actorOrgId,
    affectedOrgId: options.affectedOrgId ?? actorOrgId,
    ip: req.ip,
    ...options,
  };

  AuditEvent.create(event).catch((err) => {
    logger.warn('Failed to write audit event', { action, error: err instanceof Error ? err.message : String(err) });
  });
}
