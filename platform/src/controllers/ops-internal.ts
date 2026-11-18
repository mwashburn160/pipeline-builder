// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The identity facts ops-center needs from platform (api-core
 * `PLATFORM_INTERNAL.orgAccountRoot` / `.auditActivity` / `.liveOrgIds`).
 *
 * ops-center holds no Mongo connection: when the operations control plane
 * moved out of this service, the three reads it made of platform's own data —
 * the org hierarchy (feature quotas reserve against the account root), the
 * audit trail (the Audit Activity panels) and the live org list (a sysadmin's
 * `orgs=all` log view) — became these endpoints. Each is gated on
 * `requireInternalService({ callers: ['ops-center'] })` at the route.
 */

import { PLATFORM_INTERNAL, contractErrorMessage, parseContractBody, parseContractParams, parseContractQuery, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { withController } from '../helpers/controller-helper.js';
import { resolveOrgLineage } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
import { Organization } from '../models/index.js';
import { queryAuditStore } from '../observability/audit-store-client.js';

const { orgAccountRoot: ROOT, auditActivity: ACTIVITY, liveOrgIds: LIVE } = PLATFORM_INTERNAL;

/** GET /internal/ops/org-account-root/:orgId → `{ orgId, rootOrgId }` (404 unknown org). */
export const getOrgAccountRoot = withController('Org account root', async (req, res) => {
  const params = parseContractParams(ROOT, req);
  if (!params.ok) return sendError(res, 400, contractErrorMessage(params));
  const { orgId } = params.value;
  const exists = await Organization.exists({ _id: toOrgId(orgId) });
  if (!exists) return sendError(res, 404, 'Organization not found');
  const { rootOrgId } = await resolveOrgLineage(orgId);
  sendSuccess(res, 200, { orgId, rootOrgId: rootOrgId ?? orgId });
});

/** POST /internal/ops/audit-activity → one audit-trail aggregation for an ops dashboard panel. */
export const postAuditActivity = withController('Audit activity', async (req, res) => {
  const body = parseContractBody(ACTIVITY, req);
  if (!body.ok) return sendError(res, 400, contractErrorMessage(body));
  const { query, scope, range, end, limit, vars } = body.value;
  const result = await queryAuditStore(query, scope, { range, end, limit, vars });
  sendSuccess(res, 200, result);
});

/** GET /internal/ops/live-org-ids?limit= → `{ orgIds }`, live orgs in id order. */
export const getLiveOrgIds = withController('Live org ids', async (req, res) => {
  const q = parseContractQuery(LIVE, req);
  if (!q.ok) return sendError(res, 400, contractErrorMessage(q));
  const orgs = await Organization.find({ deletedAt: null }, { _id: 1 }).sort({ _id: 1 }).limit(q.value.limit).lean();
  sendSuccess(res, 200, { orgIds: orgs.map((o) => String(o._id)) });
});
