// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit emission for ops-center.
 *
 * The moved controllers were written against platform's local `audit(req, …)`
 * / `recordAuditEvent({…})` helpers, which wrote straight to platform's Mongo
 * audit trail. ops-center is a REMOTE service: every event goes through
 * api-core's `recordAudit` to platform's `POST /audit/events` ingest (durable
 * Redis spool on failure, hash-chained on arrival), and may only carry an
 * action in api-core `REMOTE_AUDIT_ACTIONS`. These two adapters keep the call
 * sites unchanged.
 *
 * The verified credential block (`_auth`), correlation ids, client ip and user
 * agent are stamped by `recordAudit` from the ambient request context, so they
 * are not passed here.
 */

import { ANONYMOUS_ACTOR_ID, recordAudit, SYSTEM_ORG_ID, type RemoteAuditAction } from '@pipeline-builder/api-core';
import type { Request } from 'express';

export type AuditAction = RemoteAuditAction;
export type AuditOutcome = 'success' | 'failure';

export interface AuditOptions {
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  /** The org the action touched when it is not the actor's (a sysadmin acting on another org). */
  affectedOrgId?: string;
  outcome?: AuditOutcome;
}

/** Record an event for the authenticated caller of `req`. Fire-and-forget. */
export function audit(req: Request, action: AuditAction, options: AuditOptions = {}): void {
  const actorOrgId = req.user?.organizationId;
  const orgId = actorOrgId || SYSTEM_ORG_ID;
  const affected = options.affectedOrgId ?? actorOrgId;
  recordAudit({
    action,
    actorId: req.user?.sub || ANONYMOUS_ACTOR_ID,
    ...(req.user?.email ? { actorEmail: req.user.email } : {}),
    orgId,
    ...(affected && affected !== orgId ? { affectedOrgId: affected } : {}),
    ...(options.targetType ? { targetType: options.targetType } : {}),
    ...(options.targetId ? { targetId: options.targetId } : {}),
    outcome: options.outcome ?? 'success',
    ...(options.details ? { details: options.details } : {}),
  });
}

/** A machine / sweep event with no request (Alertmanager webhooks, the retention purge). */
export interface AuditEventInput extends AuditOptions {
  action: AuditAction;
  actorId: string;
  actorEmail?: string;
  /** The org the event is recorded for (the system org for platform-operator work). */
  orgId?: string;
}

/** Record an event with no request behind it. Fire-and-forget. */
export function recordAuditEvent(event: AuditEventInput): void {
  const orgId = event.orgId || SYSTEM_ORG_ID;
  recordAudit({
    action: event.action,
    actorId: event.actorId,
    ...(event.actorEmail ? { actorEmail: event.actorEmail } : {}),
    orgId,
    ...(event.affectedOrgId && event.affectedOrgId !== orgId ? { affectedOrgId: event.affectedOrgId } : {}),
    ...(event.targetType ? { targetType: event.targetType } : {}),
    ...(event.targetId ? { targetId: event.targetId } : {}),
    outcome: event.outcome ?? 'success',
    ...(event.details ? { details: event.details } : {}),
  });
}
