// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The gate on the SCIM surface (3b): a SERVICE-ACCOUNT token carrying the `scim`
 * capability scope, and nothing else.
 *
 * Three separate things are checked, because each closes a different door:
 *
 *   1. `principalType === 'service_account'` — a PERSON's token never drives
 *      SCIM. Provisioning is machine-to-machine by construction, and admitting a
 *      user session here would mean every org admin's browser could create and
 *      deactivate memberships outside the audited member-management routes.
 *   2. `scope === 'scim'` — the key was minted for this and only this. A scoped
 *      token carries NO permissions and NO features (see `signServiceAccountToken`),
 *      so a stolen SCIM key cannot read a pipeline, author a group → Role rule, or
 *      reach any other API.
 *   3. an `organizationId` claim — every SCIM route resolves its org from the
 *      token, never from a path or a body, so a key can only ever act on the org
 *      it was minted in. A token without one is not an identity this surface can
 *      reason about, and is refused rather than defaulted.
 *
 * Runs AFTER platform's `requireAuth` (which verified the signature and the
 * claim shape). Errors are returned in the SCIM error envelope, not the
 * platform's, because the caller is an IdP that parses only SCIM.
 */

import { hasScope, tagRouteGate } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';
import { incCounter } from '../observability/metrics.js';
import { sendScimError } from '../utils/scim-response.js';

/** The capability scope every SCIM credential must carry. */
export const SCIM_SCOPE = 'scim';

export function requireScimScope(req: Request, res: Response, next: NextFunction): void {
  const principal = req.user?.principalType;
  if (principal !== 'service_account' || !hasScope(req, SCIM_SCOPE)) {
    incCounter('platform_scim_requests_total', { resource: 'unknown', operation: req.method.toLowerCase(), result: 'denied' });
    incCounter('platform_scim_errors_total', { resource: 'unknown', operation: req.method.toLowerCase(), reason: 'wrong_credential' });
    return sendScimError(
      res,
      403,
      'SCIM requires a service-account key carrying the `scim` scope. Issue one under Settings → Single Sign-On → SCIM provisioning.',
      { reason: 'wrong_credential' },
    );
  }
  if (!req.user?.organizationId) {
    incCounter('platform_scim_errors_total', { resource: 'unknown', operation: req.method.toLowerCase(), reason: 'no_org' });
    return sendScimError(res, 403, 'This credential is not scoped to an organization.', { reason: 'no_org' });
  }
  next();
}

// Declare what this service-local gate enforces so the introspected route table
// (and the route-coverage test that reads it) records the machine-scope boundary
// instead of seeing an untagged middleware.
tagRouteGate(requireScimScope, { kind: 'scope', scope: SCIM_SCOPE });
