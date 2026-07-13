// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { createLogger } from '@pipeline-builder/api-core';
import { currentTraceId } from '@pipeline-builder/api-server';
import type { Request } from 'express';
import AuditEvent, { type AuditAction } from '../models/audit-event.js';

const logger = createLogger('audit');

/** Max stored User-Agent length — a hostile/oversized UA header shouldn't
 *  bloat audit documents. 512 covers every legitimate browser/CLI UA. */
const MAX_USER_AGENT_LEN = 512;

/** Control characters (C0 + DEL + C1) replaced before storage so the value
 *  can't inject into the audit UI / CSV export when later rendered. Built
 *  from a string (not a regex literal) to keep the source ASCII-only. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');

/**
 * Sanitize a raw User-Agent header for storage: strip control characters
 * (defends the UI/CSV export against injection when the value is later
 * rendered) and truncate. Returns undefined for missing/empty input.
 */
function sanitizeUserAgent(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const cleaned = raw.replace(CONTROL_CHARS, ' ').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, MAX_USER_AGENT_LEN);
}

/**
 * Record an audit event (fire-and-forget — never blocks the request).
 *
 * @param req - Express request (used to extract actor, IP, and request/trace
 *              correlation context)
 * @param action - Audit action identifier
 * @param options - Optional target, details, `affectedOrgId` for cross-tenant
 *                  operations, `groupId`, and `outcome`
 *
 * Tracing + identity context (`requestId`, `traceId`, `actorRole`,
 * `impersonatorId`, `userAgent`) is captured centrally here so the ~45 call
 * sites don't repeat the boilerplate — every audited action inherits it.
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
    /** Permission role involved (org.role.* actions). Stored as a
     *  first-class, indexed field rather than buried in `details`. Field name
     *  kept as `groupId` for audit-log backward compatibility. */
    groupId?: string;
    /** Did the action succeed? Defaults to 'success'; pass 'failure' on
     *  failure paths (e.g. login.failed) so reviewers can filter outcomes. */
    outcome?: 'success' | 'failure';
  } = {},
): void {
  const actorOrgId = req.user?.organizationId;
  // requestId: prefer the nginx-propagated `x-request-id`; fall back to a
  // fresh uuid so service-to-service / test / non-nginx calls still get a
  // correlation key (the field is never empty).
  const rawRequestId = req.headers['x-request-id'];
  const requestId = (Array.isArray(rawRequestId) ? rawRequestId[0] : rawRequestId) || randomUUID();
  const { targetType, targetId, details, affectedOrgId, groupId, outcome } = options;

  const event = {
    action,
    actorId: req.user?.sub || 'anonymous',
    actorEmail: req.user?.email,
    actorRole: req.user?.role,
    orgId: actorOrgId,
    affectedOrgId: affectedOrgId ?? actorOrgId,
    targetType,
    targetId,
    groupId,
    impersonatorId: req.user?.impersonatorId,
    outcome: outcome ?? 'success',
    details,
    ip: req.ip,
    userAgent: sanitizeUserAgent(req.headers['user-agent']),
    requestId,
    traceId: currentTraceId(),
  };

  AuditEvent.create(event).catch((err) => {
    logger.warn('Failed to write audit event', { action, error: err instanceof Error ? err.message : String(err) });
  });
}
