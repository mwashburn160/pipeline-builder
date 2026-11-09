// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isRemoteAuditAction, isServicePrincipal, isSystemAdmin, isSystemOrgId, recordAuthzDenial, sanitizeCorrelationId, sanitizeUserAgent, parseQueryString, sendError, sendSuccess, createLogger, errorMessage, parseOptionalDate } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { getAdminContext, requirePlatformPermission, withController } from '../helpers/controller-helper.js';
import { listPage } from '../helpers/pagination.js';
import { resolveServiceTenant } from '../helpers/service-tenant.js';
import { verifyAuditChainAnchored } from '../services/audit-head-export.js';
import { auditService, type AuditFilter } from '../services/audit-service.js';

const logger = createLogger('audit-controller');

/** A date with no time part (`<input type="date">`). */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Actions whose name marks them a failure outcome (e.g. `plugin.build.failed`,
 *  `plugin.build.timeout`). Hoisted so the ingest path doesn't recompile it. */
const FAILURE_ACTION = /\.(failed|timeout)$/;

/** `GET /audit?actions=`: a bounded list of action names / `prefix.` entries. */
const MAX_ACTION_GROUP = 25;
const ACTION_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** Ingest bounds on forwarded context: an ip (v4/v6, optional zone), an OTel
 *  trace id, and an impersonator user id (an ObjectId / uuid-shaped token). */
const IP_PATTERN = /^[0-9a-fA-F:.%]{2,64}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{16,64}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A string matching `pattern`, else undefined (malformed context is dropped, not stored). */
function boundedField(raw: unknown, pattern: RegExp): string | undefined {
  return typeof raw === 'string' && pattern.test(raw) ? raw : undefined;
}

/**
 * May this service token record an event whose `affectedOrgId` is NOT its own
 * org? Three ways, all decided by the VERIFIED token, never by the body:
 *   - a sysadmin token (`isSuperAdmin`) — service tokens never carry it;
 *   - a token minted for the SYSTEM org — system work acting on a tenant (the
 *     ecosystem moderating a publisher's plugin, registry GC on a tenant repo);
 *   - the signed `auditCrossOrg` claim, which api-core's remote-audit client
 *     sets only when the event's verified INBOUND principal was a superadmin or
 *     a system-org member (an operator retrying/purging a tenant's resource).
 * A tenant-scoped token without the claim stays pinned to its own org.
 */
function mayRecordCrossOrg(req: Request): boolean {
  if (isSystemAdmin(req)) return true;
  if (!isServicePrincipal(req)) return false;
  return isSystemOrgId(req.user?.organizationId) || req.user?.auditCrossOrg === true;
}

/**
 * GET /audit - List audit events (admin only, org-scoped for org admins)
 * Query: action, actions (comma-separated group: `foo.` prefix or exact action,
 * at most 25 entries), actorId, targetType, targetId, roleId, impersonatorId,
 * requestId, outcome, from, to, offset, limit — plus orgId / affectedOrgId for
 * sysadmins (an org admin is always pinned to their own org).
 */
export const listAuditEvents = withController('List audit events', async (req, res) => {
  // AUTHORIZATION is the route's (`requirePermission('audit:read')`). What is
  // needed here is the SCOPE — whether the caller may read ACROSS orgs, or is
  // pinned to their own — so the context is read without re-gating.
  const admin = getAdminContext(req);

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
  // A bare `YYYY-MM-DD` upper bound means "through the end of that day", not
  // its first millisecond: `new Date('2026-09-21')` is midnight UTC, and the
  // inclusive `$lte` then excluded the whole day the caller named.
  const toRaw = parseQueryString(req.query.to);
  if (to && toRaw && BARE_DATE.test(toRaw)) to.setTime(to.getTime() + DAY_MS - 1);
  if (from === null || to === null) {
    return sendError(res, 400, 'from/to must be ISO dates');
  }
  const { offset, limit: limitNum } = listPage(req.query);

  const filter: AuditFilter = {};

  // PINNED UNLESS PLATFORM SYSADMIN — and the test is `isSuperAdmin`, not
  // `isOrgAdmin`, which is the whole point.
  //
  // This branch used to read `if (admin.isOrgAdmin)`, which was safe only while
  // the controller ALSO called `requireAdminContext` — that refused anyone who
  // was neither a superadmin nor an org admin, so the `else` was reachable by
  // superadmins alone. When authorization moved to the route
  // (`requirePermission('audit:read')`) that guard went away, and `audit:read`
  // is ORG-ASSIGNABLE: an org admin may delegate it to a plain member through a
  // custom Role. Such a member is not `isOrgAdmin`, fell into the `else`, and
  // could read ANY tenant's audit log with `?orgId=`.
  //
  // Keyed on the flag, every non-superadmin is pinned: an org admin as before,
  // and now the delegate too. Cross-org filtering stays what the docs say it is
  // — sysadmin only.
  if (!admin.isSuperAdmin) {
    // Pinned callers see events where their org was either the actor (orgId)
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
 * and returns `{ ok, brokenAt?, reason?, count, lastSeq, publishedHead? }`.
 * `ok:false` means a stored row was ALTERED, DELETED or RE-ORDERED after the
 * fact, or the chain no longer reaches its published write-once head (tail
 * truncation) — a tamper signal. This reads
 * nothing sensitive back (only hashes + a boolean), but it exposes cross-tenant
 * chain state, so it's gated to platform sysadmins, not org admins.
 */
export const verifyAuditChainHandler = withController('Verify audit chain', async (req, res) => {
  if (!requirePlatformPermission(req, res, 'audit:read')) return;

  const orgId = parseQueryString(req.query.orgId);
  if (!orgId) {
    return sendError(res, 400, 'orgId query parameter is required');
  }

  // PINNED UNLESS PLATFORM SYSADMIN — the same rule `listAuditEvents` applies
  // above, and for the same reason, which this handler was missing.
  //
  // `requirePlatformPermission` reads as though it settles this: its doc says a
  // cross-tenant surface is safe on a permission "because the permission is in
  // `SYSTEM_ORG_ONLY_PERMISSIONS`, it can never be granted inside a tenant org".
  // That is true of its other call sites and FALSE here — `audit:read` is
  // org-assignable, in the admin bundle, and delegatable to a plain member
  // through a custom Role. So any tenant's holder could name another org in
  // `?orgId=` and read its chain state: ok, brokenAt, reason, count, lastSeq,
  // publishedHead. Hashes and a boolean, but a cross-tenant answer about
  // whether someone else's audit trail is intact.
  //
  // Keyed on the FLAG, not on `isOrgAdmin`: the delegate is not an org admin
  // either, which is precisely how the sibling handler's version of this bug
  // stayed open.
  const admin = getAdminContext(req);
  if (!admin.isSuperAdmin && orgId !== req.user!.organizationId) {
    recordAuthzDenial(req, 'audit:read');
    return sendError(res, 403, 'Forbidden: verifying another organization\'s audit chain requires a platform administrator');
  }

  // Verified against the chain's PUBLISHED (write-once) head too, when an export
  // target is configured — that's what exposes tail truncation.
  const result = await verifyAuditChainAnchored(orgId);
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
    // Transport/correlation context a service caller forwards — stamped by the
    // remote-audit client from its ambient request context, not by call sites.
    // `actorRole` is deliberately NOT read from the body.
    //
    // `impersonatorId` IS read, on this trust model: the ingest accepts only
    // service tokens (signed by the emitting service's own key), and api-core's
    // client fills `impersonatorId` SOLELY from the verified JWT of the request
    // it is serving — it is not a field of the call-site event type, so no route
    // can set it. The service is trusted for it exactly as it is for `actorId`.
    impersonatorId?: string;
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
  // (see resolveServiceTenant). `affectedOrgId` may name another org only when
  // the verified token allows it (see mayRecordCrossOrg). Refusals are 4xx, so
  // the client drops (and meters) them rather than retrying forever.
  const effectiveOrgId = resolveServiceTenant(req, res, body.orgId);
  if (effectiveOrgId === null) return;
  if (body.affectedOrgId && body.affectedOrgId !== effectiveOrgId && !mayRecordCrossOrg(req)) {
    recordAuthzDenial(req, 'audit:cross-org');
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
      // Forwarded context (see body type comment). Each is bounds-checked and
      // a malformed value is dropped, never stored: these land in the hash
      // chain and are rendered in the audit UI / CSV export.
      impersonatorId: boundedField(body.impersonatorId, USER_ID_PATTERN),
      ip: boundedField(body.ip, IP_PATTERN),
      userAgent: sanitizeUserAgent(body.userAgent),
      requestId: sanitizeCorrelationId(body.requestId),
      traceId: boundedField(body.traceId, TRACE_ID_PATTERN),
      // Display-only emission time (undefined when absent/omitted).
      occurredAt,
    });
    return sendSuccess(res, 200, {});
  } catch (error) {
    logger.warn('[AUDIT] Ingest failed', { action: body.action, error: errorMessage(error) });
    return sendError(res, 500, 'Failed to record audit event');
  }
}
