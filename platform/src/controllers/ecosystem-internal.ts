// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/internal/ecosystem/*` — the two platform reads the plugin service's
 * ecosystem governance needs (Verified-publisher eligibility and the approver
 * count behind two-person approval — docs/runbooks/ecosystem-moderation.md).
 * INTERNAL routes: the `plugin` service's signed token only (the route gate);
 * no user token reaches them. Both return counts and domain names, never a
 * member list.
 *
 *  - `GET /internal/ecosystem/publisher-eligibility/:orgId` — the Verified
 *    application's platform-held checks: the org's DNS-verified domains and
 *    whether its owners have a second factor.
 *  - `GET /internal/ecosystem/approvers?permission=…&excludeOrgIds=…&excludeUserIds=…`
 *    — how many Ecosystem Managers could decide (holders of the permission in
 *    the system org, minus the named conflicts of interest).
 */

import { getParam, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { withController } from '../helpers/controller-helper.js';
import { countEcosystemApprovers } from '../services/ecosystem-notifications.js';
import { publisherEligibilityFacts } from '../services/publisher-eligibility.js';

/** The only permissions an ecosystem decision can require. */
const DECISION_PERMISSIONS = ['plugins:moderate', 'publishers:verify'] as const;

const ORG_ID = /^[a-f0-9]{24}$/i;
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A comma-separated query value as a de-duplicated, capped, validated list. */
function listParam(raw: unknown, valid: RegExp, normalize: (s: string) => string = (s) => s): string[] | null {
  if (raw === undefined || raw === '') return [];
  if (typeof raw !== 'string') return null;
  const items = [...new Set(raw.split(',').map((s) => normalize(s.trim())).filter(Boolean))];
  if (items.length > 20 || items.some((s) => !valid.test(s))) return null;
  return items;
}

/** GET /internal/ecosystem/publisher-eligibility/:orgId */
export const getPublisherEligibility = withController('Publisher eligibility', async (req, res) => {
  const orgId = getParam(req.params, 'orgId') ?? '';
  if (!ORG_ID.test(orgId)) return sendError(res, 400, 'orgId must be an organization id');
  sendSuccess(res, 200, await publisherEligibilityFacts(orgId.toLowerCase()));
});

/** GET /internal/ecosystem/approvers */
export const getEcosystemApprovers = withController('Ecosystem approvers', async (req, res) => {
  const permission = req.query.permission;
  if (typeof permission !== 'string' || !(DECISION_PERMISSIONS as readonly string[]).includes(permission)) {
    return sendError(res, 400, `permission must be one of: ${DECISION_PERMISSIONS.join(', ')}`);
  }
  const orgIds = listParam(req.query.excludeOrgIds, ORG_ID, (s) => s.toLowerCase());
  const userIds = listParam(req.query.excludeUserIds, USER_ID);
  if (!orgIds || !userIds) return sendError(res, 400, 'excludeOrgIds / excludeUserIds must be comma-separated ids (at most 20)');
  sendSuccess(res, 200, await countEcosystemApprovers(permission, {
    memberOfOrgIds: orgIds,
    userIds,
  }));
});
