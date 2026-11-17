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

import {
  PLATFORM_INTERNAL,
  contractErrorMessage,
  parseContractParams,
  parseContractQuery,
  sendError,
  sendSuccess,
  splitIdList,
} from '@pipeline-builder/api-core';
import { withController } from '../helpers/controller-helper.js';
import { countEcosystemApprovers } from '../services/ecosystem-notifications.js';
import { publisherEligibilityFacts } from '../services/publisher-eligibility.js';

/**
 * Params and query are validated by the endpoints' contracts (api-core
 * `PLATFORM_INTERNAL`), which carry this route's 400 messages: the org id shape,
 * the decision-permission allow-list and the capped, de-duplicated id lists.
 */
const { publisherEligibility: ELIGIBILITY, ecosystemApprovers: APPROVERS } = PLATFORM_INTERNAL;

/** GET /internal/ecosystem/publisher-eligibility/:orgId */
export const getPublisherEligibility = withController('Publisher eligibility', async (req, res) => {
  const params = parseContractParams(ELIGIBILITY, req);
  if (!params.ok) return sendError(res, 400, contractErrorMessage(params));
  sendSuccess(res, 200, await publisherEligibilityFacts(params.value.orgId));
});

/** GET /internal/ecosystem/approvers */
export const getEcosystemApprovers = withController('Ecosystem approvers', async (req, res) => {
  // The permission is checked first: its issue precedes the lists' in the schema.
  const query = parseContractQuery(APPROVERS, req);
  if (!query.ok) return sendError(res, 400, contractErrorMessage(query));
  const { permission, excludeOrgIds, excludeUserIds } = query.value;
  sendSuccess(res, 200, await countEcosystemApprovers(permission, {
    memberOfOrgIds: splitIdList(excludeOrgIds),
    userIds: splitIdList(excludeUserIds),
  }));
});
