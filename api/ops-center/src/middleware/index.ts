// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The auth gate the moved routers import as `../middleware/index.js`. In
 * platform it was platform's own DB-backed `requireAuth`; here it is api-core's
 * stateless one (signature against platform's JWKS + the shared revocation
 * store), exactly as every other api service authenticates.
 */

import { isSystemAdmin } from '@pipeline-builder/api-core';
import { withTenantContext } from '@pipeline-builder/api-server';
import type { Request, RequestHandler } from 'express';

export { requireAuth } from '@pipeline-builder/api-core';

/**
 * The RLS tenant scope for the rest of the request, from the VERIFIED token
 * (mounted right after `requireAuth`). Platform set this pre-auth from a
 * JWT peek; here the verified claims are already on `req.user`.
 */
export const tenantScope: RequestHandler = withTenantContext((req: Request) => ({
  orgId: (req.user?.organizationId ?? '').trim().toLowerCase(),
  userId: req.user?.sub || undefined,
  isSuperAdmin: isSystemAdmin(req),
  parentOrgId: req.user?.parentOrganizationId,
})) as RequestHandler;
