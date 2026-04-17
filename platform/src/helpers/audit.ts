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
 * @param options - Optional target and details
 */
export function audit(
  req: Request,
  action: AuditAction,
  options: {
    targetType?: string;
    targetId?: string;
    details?: Record<string, unknown>;
  } = {},
): void {
  const event = {
    action,
    actorId: req.user?.sub || 'anonymous',
    actorEmail: req.user?.email,
    orgId: req.user?.organizationId,
    ip: req.ip,
    ...options,
  };

  AuditEvent.create(event).catch((err) => {
    logger.warn('Failed to write audit event', { action, error: err instanceof Error ? err.message : String(err) });
  });
}
