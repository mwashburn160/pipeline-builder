// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isRemoteAuditAction, isSystemAdmin, parseQueryString, sendError, sendSuccess, createLogger, parsePaginationParams, errorMessage } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { verifyAuditChain } from '../helpers/audit-chain.js';
import { requireAdminContext, requireSystemAdmin, withController } from '../helpers/controller-helper.js';
import { resolveServiceTenant } from '../helpers/service-tenant.js';
import { auditService, type AuditFilter } from '../services/audit-service.js';

const logger = createLogger('audit-controller');

/** Parse an optional ISO date query param; returns undefined if absent, or null
 *  if malformed (caller answers a malformed value with a 400). Mirrors the
 *  billing-summary `parseOptionalDate` pattern. */
function parseOptionalDate(raw: unknown): Date | undefined | null {
  const s = parseQueryString(raw);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Actions whose name marks them a failure outcome (e.g. `plugin.build.failed`,
 *  `plugin.build.timeout`). Hoisted so the ingest path doesn't recompile it. */
const FAILURE_ACTION = /\.(failed|timeout)$/;

/** `GET /audit?actions=`: a bounded list of action names / `prefix.` entries. */
const MAX_ACTION_GROUP = 25;
const ACTION_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * GET /audit - List audit events (admin only, org-scoped for org admins)
 * Query: action, actions (comma-separated group: `foo.` prefix or exact action,
 * at most 25 entries), actorId, targetType, targetId, roleId, impersonatorId,
 * requestId, outcome, from, to, offset, limit — plus orgId / affectedOrgId for
 * sysadmins (an org admin is always pinned to their own org).
 */
export const listAuditEvents = withController('List audit events', async (req, res) => {
  const admin = requireAdminContext(req, res);
  if (!admin) return;

  // Parse possibly-array query strings safely. Express's qs parser can
  // return `string | string[] | ParsedQs` — `parseQueryString` collapses
  // all of those to `string | undefined`.
  const action = parseQueryString(req.query.action);
  const actionsRaw = parseQueryString(req.query.actions);
  const actions = actionsRaw
    ? actionsRaw.split(',').map((a) => a.trim()).filter((a) => a.length > 0)
    : [];
  if (actions.length > MAX_ACTION_GROUP || actions.some((a) => a.length > 100 || !ACTION_PATTERN.test(a))) {
    return sendError(res, 400, `actions must be at most ${MAX_ACTION_GROUP} comma-separated action names or prefixes`);
  }
  const targetType = parseQueryString(req.query.targetType);
  const targetId = parseQueryString(req.query.targetId);
  const affectedOrgId = parseQueryString(req.query.affectedOrgId);
  const actorId = parseQueryString(req.query.actorId);
  const orgIdQuery = parseQueryString(req.query.orgId);
  const roleId = parseQueryString(req.query.roleId);
  const impersonatorId = parseQueryString(req.query.impersonatorId);
  const requestId = parseQueryString(req.query.requestId);
  const outcomeQuery = parseQueryString(req.query.outcome);
  // Read-time createdAt range. Malformed (non-parseable) values are rejected
  // with a 400 BEFORE any query is issued, mirroring billing-summary.
  const from = parseOptionalDate(req.query.from);
  const to = parseOptionalDate(req.query.to);
  if (from === null || to === null) {
    return sendError(res, 400, 'from/to must be ISO dates');
  }
  const { offset, limit: limitNum } = parsePaginationParams(req.query);

  const filter: AuditFilter = {};

  if (admin.isOrgAdmin) {
    // Org admins see events where their org was either the actor (orgId)
    // OR the affected target (affectedOrgId). `orgIdOrAffected` translates
    // to a Mongo `$or` in the service so a sysadmin's cross-tenant action
    // ON their org is visible alongside their own in-tenant actions.
    filter.orgIdOrAffected = req.user!.organizationId;
  } else {
    if (orgIdQuery) filter.orgId = orgIdQuery;
    if (affectedOrgId) filter.affectedOrgId = affectedOrgId;
  }

  // "What did user X do" narrows WITHIN the scope above — for an org admin it
  // stays inside their own org, so it reveals nothing they couldn't page to.
  if (actorId) filter.actorId = actorId;

  if (action) filter.action = action;
  if (actions.length > 0) filter.actions = actions;
  if (targetType) filter.targetType = targetType;
  if (targetId) filter.targetId = targetId;
  if (roleId) filter.roleId = roleId;
  if (impersonatorId) filter.impersonatorId = impersonatorId;
  if (requestId) filter.requestId = requestId;
  if (outcomeQuery === 'success' || outcomeQuery === 'failure') filter.outcome = outcomeQuery;
  if (from) filter.createdFrom = from;
  if (to) filter.createdTo = to;

  const result = await auditService.findEvents(filter, offset, limitNum);

  sendSuccess(res, 200, result);
});

/**
 * GET /audit/verify?orgId=... — verify a tenant's audit hash chain (sysadmin
 * only). Walks the chain for `orgId` (the `affectedOrgId ?? orgId` chain key)
 * and returns `{ ok, brokenAt?, count }`. `ok:false` with `brokenAt` set means a
 * stored row was ALTERED or DELETED after the fact — a tamper signal. This reads
 * nothing sensitive back (only hashes + a boolean), but it exposes cross-tenant
 * chain state, so it's gated to platform sysadmins, not org admins.
 */
export const verifyAuditChainHandler = withController('Verify audit chain', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const orgId = parseQueryString(req.query.orgId);
  if (!orgId) {
    return sendError(res, 400, 'orgId query parameter is required');
  }

  const result = await verifyAuditChain(orgId);
  sendSuccess(res, 200, result);
});

/**
 * POST /audit/events — internal ingest endpoint for non-platform services.
 *
 * Used today by the plugin build worker (api/plugin) to push
 * `plugin.build.{completed,failed,timeout}` events into the MongoDB audit
 * log. Auth: service-only JWT (rejects user tokens). Body validation is
 * strict on `action` to keep the action vocabulary closed; everything else
 * is optional. Returns 200 with no body on success.
 *
 * Fire-and-forget by convention — callers shouldn't block on the response.
 */
export async function ingestAuditEvent(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    action?: string;
    actorId?: string;
    actorEmail?: string;
    orgId?: string;
    affectedOrgId?: string;
    targetType?: string;
    targetId?: string;
    details?: Record<string, unknown>;
    ip?: string;
    // Transport/correlation context a service caller may forward. `actorRole`
    // and `impersonatorId` are deliberately NOT read from the body — those are
    // forensic identity claims that are only trustworthy when derived from a
    // verified `req.user` (the platform `audit()` helper), never self-asserted
    // by a service token.
    userAgent?: string;
    requestId?: string;
    traceId?: string;
    outcome?: 'success' | 'failure';
    // DISPLAY-ONLY emission timestamp the remote-audit client stamps when the
    // action actually happened (ISO-8601). May arrive much later than it
    // occurred if the client spooled it through a platform outage. Stored for
    // reviewers; it never becomes the hash-chain ordering field.
    occurredAt?: string;
  };

  // Validate against the REMOTE subset — NOT the full platform union. A
  // `service:*` token must not be able to forge platform-authority events
  // (`admin.superadmin.grant`, `org.ownership.transfer`, `user.login`, …) with
  // an attacker-chosen `actorId`; the ingest is restricted to the legitimate
  // remote vocabulary (plugin.*/pipeline.*/quota.*/compliance.*/registry.*/
  // authz.denied). See api-core `REMOTE_AUDIT_ACTIONS`.
  if (!body.action || typeof body.action !== 'string' || !isRemoteAuditAction(body.action)) {
    return sendError(res, 400, 'Invalid or unknown action');
  }
  if (!body.actorId || typeof body.actorId !== 'string') {
    return sendError(res, 400, 'actorId is required');
  }

  // Tenant binding: a non-sysadmin service token records events for ITS org only
  // (see resolveServiceTenant). `affectedOrgId` gets the same binding — only a
  // sysadmin service may ingest on behalf of another org.
  const effectiveOrgId = resolveServiceTenant(req, res, body.orgId);
  if (effectiveOrgId === null) return;
  if (body.affectedOrgId && body.affectedOrgId !== effectiveOrgId && !isSystemAdmin(req)) {
    return sendError(res, 403, 'affectedOrgId not allowed for this service token');
  }
  const effectiveAffectedOrgId = body.affectedOrgId ?? effectiveOrgId;

  // Derive outcome: honour an explicit body value, else infer from the action
  // vocabulary so `plugin.build.{failed,timeout}` land as failures without the
  // worker having to set it.
  const outcome: 'success' | 'failure' = body.outcome
    ?? (FAILURE_ACTION.test(body.action) ? 'failure' : 'success');

  // A stable per-emission `Idempotency-Key` (set by the remote-audit client) lets
  // a retried 5xx/timeout delivery dedup at the DB instead of writing a duplicate
  // row / extending the chain twice. Empty/blank header ⇒ undefined (unconstrained).
  const idempotencyKey = req.header('Idempotency-Key')?.trim() || undefined;

  // occurredAt (optional): the ISO-8601 instant the action actually happened,
  // as stamped by the remote-audit client. Reject a malformed value with 400
  // (mirroring the strict body validation above for action/actorId) rather than
  // silently storing garbage; when absent, leave it unset so reviewers fall
  // back to the ingest `createdAt`. DISPLAY-ONLY — it never influences the
  // hash-chain ordering (the chain orders by ingest createdAt).
  let occurredAt: Date | undefined;
  if (body.occurredAt !== undefined) {
    const parsed = typeof body.occurredAt === 'string' ? new Date(body.occurredAt) : new Date(NaN);
    if (Number.isNaN(parsed.getTime())) {
      return sendError(res, 400, 'occurredAt must be a valid ISO-8601 date string');
    }
    occurredAt = parsed;
  }

  try {
    await auditService.createEvent({
      action: body.action,
      actorId: body.actorId,
      actorEmail: body.actorEmail,
      orgId: effectiveOrgId,
      idempotencyKey,
      // Mirror the pre-refactor behavior: default affectedOrgId to orgId
      // for in-tenant actions; explicit cross-tenant callers (sysadmin
      // services acting on another org) pass it themselves.
      affectedOrgId: effectiveAffectedOrgId,
      targetType: body.targetType,
      targetId: body.targetId,
      outcome,
      details: body.details,
      ip: body.ip,
      // Transport context only (see body type comment) — forensic identity
      // claims are never accepted from the service body.
      userAgent: body.userAgent,
      requestId: body.requestId,
      traceId: body.traceId,
      // Display-only emission time (undefined when absent/omitted).
      occurredAt,
    });
    return sendSuccess(res, 200, {});
  } catch (error) {
    logger.warn('[AUDIT] Ingest failed', { action: body.action, error: errorMessage(error) });
    return sendError(res, 500, 'Failed to record audit event');
  }
}
