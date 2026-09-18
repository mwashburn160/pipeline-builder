// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SCIM 2.0 HTTP layer (3b) — the twelve handlers under `/scim/v2`.
 *
 * Everything that is protocol lives here; everything that is policy lives in
 * `services/scim-service.ts`. Specifically, this module owns:
 *
 *   - THE CONTEXT. The org comes from the VERIFIED token (`req.user.organizationId`),
 *     never from a path segment or a body, and its live `sso` entitlement is
 *     resolved once per request. A SCIM key therefore cannot address another org
 *     even if an IdP is configured with the wrong base URL.
 *   - THE ENVELOPE. SCIM answers are `application/scim+json`, and a failure is an
 *     `…:2.0:Error` document with a string `status` — not the platform's
 *     `{ success, … }` shape, which no IdP parses.
 *   - THE RECORD. Every write emits an audit event naming what moved (attribute
 *     names, never their values) and a metric labelled by resource, operation and
 *     result; every refusal emits `org.scim.refused` with the reason, so a
 *     failing directory sync is visible in the audit log rather than only in the
 *     IdP's own console.
 *   - THE NOTICE. A refusal because the entitlement lapsed also tells the org's
 *     admins (throttled to once a day) — the plan's "admins are notified".
 */

import { createLogger, getParam } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { audit } from '../helpers/audit.js';
import { notifyScimEntitlementLapsed } from '../helpers/scim-entitlement-notice.js';
import { isSsoEntitled } from '../helpers/sso-enforcement.js';
import type { AuditAction } from '../models/audit-event.js';
import { incCounter } from '../observability/metrics.js';
import { isScimError } from '../services/scim-errors.js';
import {
  createGroup,
  createUser,
  deleteGroup,
  deleteUser,
  getGroup,
  getUser,
  listGroups,
  listUsers,
  patchGroup,
  patchUser,
  replaceGroup,
  replaceUser,
  resourceTypes,
  schemas,
  serviceProviderConfig,
  type ScimContext,
  type ScimListQuery,
  type ScimWriteOutcome,
} from '../services/scim-service.js';
import { sendScim, sendScimError } from '../utils/scim-response.js';

const logger = createLogger('scim-controller');

type ScimResource = 'User' | 'Group' | 'discovery';

/** Audit action per (resource, outcome). One table, so a new outcome can't be
 *  audited under two different names from two call sites. */
const AUDIT_ACTIONS: Record<'User' | 'Group', Record<ScimWriteOutcome<unknown>['action'], AuditAction>> = {
  User: {
    create: 'org.scim.user.create',
    update: 'org.scim.user.update',
    activate: 'org.scim.user.activate',
    deactivate: 'org.scim.user.deactivate',
    delete: 'org.scim.user.delete',
    members: 'org.scim.user.update',
  },
  Group: {
    create: 'org.scim.group.create',
    update: 'org.scim.group.update',
    activate: 'org.scim.group.update',
    deactivate: 'org.scim.group.update',
    delete: 'org.scim.group.delete',
    members: 'org.scim.group.members',
  },
};

/**
 * Build the request's context. `isSsoEntitled` is the SAME resolver that gates
 * OIDC SSO and JIT — read live per request (not from the token) so a downgrade
 * takes effect on the next call rather than at key expiry, which can be a year.
 */
async function contextOf(req: Request): Promise<ScimContext> {
  const orgId = req.user!.organizationId as string;
  return { orgId, entitled: await isSsoEntitled(orgId) };
}

/**
 * Wrap a SCIM handler: one context, one metric per outcome, SCIM error bodies,
 * and no stack traces on the wire. `operation` is the low-cardinality metric
 * label (`list`, `get`, `create`, …), not the HTTP verb, so "creates are failing"
 * is one query.
 */
function withScim(
  resource: ScimResource,
  operation: string,
  handler: (req: Request, res: Response, ctx: ScimContext) => Promise<void>,
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response) => {
    const labels = { resource, operation };
    try {
      const ctx = await contextOf(req);
      await handler(req, res, ctx);
      incCounter('platform_scim_requests_total', { ...labels, result: 'success' });
    } catch (err) {
      if (isScimError(err)) {
        incCounter('platform_scim_requests_total', { ...labels, result: 'error' });
        incCounter('platform_scim_errors_total', { ...labels, reason: err.reason });
        // The refusal itself is auditable: a directory whose syncs are being
        // turned away is a security-relevant state, and `details.reason` is what
        // an admin needs to fix it.
        audit(req, 'org.scim.refused', {
          targetType: resource,
          ...(req.params?.id ? { targetId: getParam(req.params, 'id')! } : {}),
          affectedOrgId: req.user?.organizationId,
          outcome: 'failure',
          details: { operation, reason: err.reason, status: err.status, ...(err.scimType ? { scimType: err.scimType } : {}) },
        });
        // The plan's "admins are notified" — only for the downgrade case, and
        // only once a day (the helper owns the throttle). Fire-and-forget.
        if (err.reason === 'not_entitled' && req.user?.organizationId) {
          void notifyScimEntitlementLapsed(req.user.organizationId);
        }
        if (!res.headersSent) sendScimError(res, err.status, err.message, { ...(err.scimType ? { scimType: err.scimType } : {}) });
        return;
      }
      incCounter('platform_scim_requests_total', { ...labels, result: 'error' });
      incCounter('platform_scim_errors_total', { ...labels, reason: 'internal' });
      // Log locally; the IdP gets a bare 500 with no internals.
      logger.error(`[SCIM ${operation} ${resource}] Error`, err);
      if (!res.headersSent) sendScimError(res, 500, 'The SCIM request could not be completed.');
    }
  };
}

/** Record one successful write: the audit row plus the resource's location. */
function auditWrite(req: Request, resource: 'User' | 'Group', outcome: ScimWriteOutcome<{ id: string }>): void {
  audit(req, AUDIT_ACTIONS[resource][outcome.action], {
    targetType: resource,
    targetId: outcome.resource.id,
    affectedOrgId: req.user?.organizationId,
    details: {
      // WHICH attributes moved — never their values. A directory sync carries
      // personal data, and an audit reader needs the shape of the change, not a
      // second copy of the payload.
      changed: outcome.changed,
      ...(outcome.affectedUserIds && outcome.affectedUserIds.length > 0
        ? { membersAffected: outcome.affectedUserIds.length }
        : {}),
    },
  });
}

const query = (req: Request): ScimListQuery => ({
  filter: typeof req.query.filter === 'string' ? req.query.filter : undefined,
  startIndex: typeof req.query.startIndex === 'string' ? req.query.startIndex : undefined,
  count: typeof req.query.count === 'string' ? req.query.count : undefined,
});

const body = (req: Request): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {});

// -- Users -------------------------------------------------------------------

export const scimListUsers = withScim('User', 'list', async (req, res, ctx) => {
  sendScim(res, 200, await listUsers(ctx, query(req)));
});

export const scimGetUser = withScim('User', 'get', async (req, res, ctx) => {
  sendScim(res, 200, await getUser(ctx, getParam(req.params, 'id')!));
});

export const scimCreateUser = withScim('User', 'create', async (req, res, ctx) => {
  const outcome = await createUser(ctx, body(req));
  auditWrite(req, 'User', outcome);
  sendScim(res, 201, outcome.resource, { Location: outcome.resource.meta.location });
});

export const scimReplaceUser = withScim('User', 'replace', async (req, res, ctx) => {
  const outcome = await replaceUser(ctx, getParam(req.params, 'id')!, body(req));
  auditWrite(req, 'User', outcome);
  sendScim(res, 200, outcome.resource);
});

export const scimPatchUser = withScim('User', 'patch', async (req, res, ctx) => {
  const outcome = await patchUser(ctx, getParam(req.params, 'id')!, body(req).Operations ?? body(req).operations);
  auditWrite(req, 'User', outcome);
  sendScim(res, 200, outcome.resource);
});

export const scimDeleteUser = withScim('User', 'delete', async (req, res, ctx) => {
  const outcome = await deleteUser(ctx, getParam(req.params, 'id')!);
  auditWrite(req, 'User', outcome);
  // 204, per RFC 7644 §3.6 — no body.
  res.status(204).end();
});

// -- Groups ------------------------------------------------------------------

export const scimListGroups = withScim('Group', 'list', async (req, res, ctx) => {
  sendScim(res, 200, await listGroups(ctx, query(req)));
});

export const scimGetGroup = withScim('Group', 'get', async (req, res, ctx) => {
  sendScim(res, 200, await getGroup(ctx, getParam(req.params, 'id')!));
});

export const scimCreateGroup = withScim('Group', 'create', async (req, res, ctx) => {
  const outcome = await createGroup(ctx, body(req));
  auditWrite(req, 'Group', outcome);
  sendScim(res, 201, outcome.resource, { Location: outcome.resource.meta.location });
});

export const scimReplaceGroup = withScim('Group', 'replace', async (req, res, ctx) => {
  const outcome = await replaceGroup(ctx, getParam(req.params, 'id')!, body(req));
  auditWrite(req, 'Group', outcome);
  sendScim(res, 200, outcome.resource);
});

export const scimPatchGroup = withScim('Group', 'patch', async (req, res, ctx) => {
  const outcome = await patchGroup(ctx, getParam(req.params, 'id')!, body(req).Operations ?? body(req).operations);
  auditWrite(req, 'Group', outcome);
  sendScim(res, 200, outcome.resource);
});

export const scimDeleteGroup = withScim('Group', 'delete', async (req, res, ctx) => {
  const outcome = await deleteGroup(ctx, getParam(req.params, 'id')!);
  auditWrite(req, 'Group', outcome);
  res.status(204).end();
});

// -- Discovery (RFC 7643 §§5-6) ----------------------------------------------
// What an Okta/Entra validator fetches before it sends anything. Entitlement is
// deliberately NOT checked here: these documents describe the API, carry no
// tenant data, and an IdP that cannot read them cannot even reach the
// deactivate path a downgraded org still depends on.

export const scimServiceProviderConfig = withScim('discovery', 'service-provider-config', async (_req, res) => {
  sendScim(res, 200, await serviceProviderConfig());
});

export const scimResourceTypes = withScim('discovery', 'resource-types', async (_req, res) => {
  sendScim(res, 200, await resourceTypes());
});

export const scimSchemas = withScim('discovery', 'schemas', async (_req, res) => {
  sendScim(res, 200, await schemas());
});
