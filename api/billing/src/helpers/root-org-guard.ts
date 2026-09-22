// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  createLogger,
  ErrorCode,
  errorMessage,
  fetchParentOrgId,
  sendError,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import type { NextFunction, Request, Response } from 'express';

const logger = createLogger('billing-root-org-guard');

/**
 * Billing is account-scoped: the ROOT org of a hierarchy owns the subscription,
 * its add-ons and the pooled caps every team draws from. A team (child) org that
 * could mint its own subscription / checkout / add-on / portal session would get
 * a second, independent entitlement set pushed to its own org id — escaping the
 * root's pooled caps and splitting the account's billing relationship.
 *
 * Mount AFTER `requireAuth` on every mutating subscription/add-on/discount/
 * checkout/portal/claim route. A team is recognised from the verified token:
 * `parentOrganizationId` set, or a `rootOrganizationId` that isn't the active org.
 *
 * A sysadmin acting on another org via the `x-org-id` override carries claims
 * about THEIR OWN org, not the target — so for them the target's parent is
 * resolved from platform, fail-CLOSED (a lookup failure refuses with 503 rather
 * than risk provisioning a team).
 */
export async function refuseTeamBilling(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = req.user;
  const orgId = user?.organizationId;
  if (!user || !orgId) { next(); return; } // withRoute answers the missing-org case.

  let parent: string | undefined;
  if (user.isSuperAdmin === true) {
    try {
      parent = await fetchParentOrgId(orgId, {
        authOrgId: SYSTEM_ORG_ID,
        throwOnHttpError: true,
      });
    } catch (err) {
      logger.error('Parent-org lookup failed; refusing billing write', { orgId, error: errorMessage(err) });
      sendError(res, 503, 'Could not verify the organization hierarchy; try again', ErrorCode.SERVICE_UNAVAILABLE);
      return;
    }
  } else {
    parent = user.parentOrganizationId
      ?? (user.rootOrganizationId && user.rootOrganizationId !== orgId ? user.rootOrganizationId : undefined);
  }

  if (parent) {
    sendError(
      res, 403,
      'Billing is managed by the parent organization. Switch to the account\'s root organization to change the subscription.',
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
    return;
  }
  next();
}
