// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/internal/support/*` — the entitlement fact the message service cannot know.
 * INTERNAL: the `message` service's signed token only.
 *
 * The message service owns the support thread, so it owns the moment a case is
 * opened. It cannot decide whether a case is ALLOWED: `supportContacts` is not a
 * quota-service type (absent from `VALID_QUOTA_TYPES`, like `seats`), and the
 * effective limit is tier base plus bundles, which only billing computes.
 * Billing already syncs it onto the root org beside `seats`, so this is answered
 * from platform's own store with no further hop.
 *
 * Answered FRESH on every call rather than from a cached push, for the same
 * reason the reporting authority read is: an add-on that lapsed, or a contact
 * that was revoked, has to stop the NEXT case — not the next sync. The caller
 * keeps a short last-known-good copy purely to survive an outage, and that
 * fallback is its decision, not ours.
 */

import { getParam, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { withController } from '../helpers/controller-helper.js';
import { supportEntitlement } from '../helpers/support-entitlement.js';

/** Organization ids are 24-hex ObjectIds. */
const ORG_ID = /^[a-f0-9]{24}$/i;

/**
 * May this org open a support case, and at what level?
 *
 * Returns the whole decision rather than a boolean so the caller can log WHY it
 * refused and freeze the right `level` onto the case it creates. The two scopes
 * in the payload are deliberate — the allowance pools subtree-wide, ownership is
 * own-org — and are documented on `SupportEntitlement`.
 *
 * A missing org is NOT an error: it answers "no entitlement", because an org id
 * that no longer resolves cannot have support and the caller's response is the
 * same either way. Returning 404 would make the message service treat a deleted
 * org as an outage and fall back to a stale cached grant.
 */
export const getSupportEntitlement = withController('Support entitlement', async (req, res) => {
  const orgId = (getParam(req.params, 'orgId') ?? '').toLowerCase();
  if (!ORG_ID.test(orgId)) return sendError(res, 400, 'orgId must be an organization id');
  return sendSuccess(res, 200, await supportEntitlement(orgId));
});
