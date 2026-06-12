// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { QuotaType, QuotaService } from '@pipeline-builder/api-core';
import type { RequestHandler } from 'express';
import { checkQuota } from './check-quota.js';
import { requireAuth } from './middleware.js';
import { requireOrgId } from './require-org-id.js';
import { withTenantContext } from './tenant-context.js';

/**
 * Creates a middleware chain for protected routes requiring authentication, org ID, and quota check.
 *
 * Applies middleware in order:
 * 1. requireAuth - Validates JWT and extracts user identity
 * 2. requireOrgId - Ensures request has x-org-id header
 * 3. withTenantContext - Opens the RLS tenant scope (orgId + isSuperAdmin) for the request
 * 4. checkQuota - Validates quota for the specified resource type
 *
 * @param quotaService - Quota service client
 * @param quotaType - Which quota to check (e.g., 'apiCalls', 'pipelines', 'plugins')
 * @returns Array of middleware handlers ready to spread into route definition
 *
 * @example
 * ```typescript
 * router.post('/',
 *   ...createProtectedRoute(quotaService, 'pipelines'),
 *   async (req, res) => {
 *     // Handler implementation
 *   }
 * );
 * ```
 */
export function createProtectedRoute(
  quotaService: QuotaService,
  quotaType: QuotaType,
): RequestHandler[] {
  return [
    requireAuth as RequestHandler,
    requireOrgId() as RequestHandler,
    withTenantContext() as RequestHandler,
    checkQuota(quotaService, quotaType) as RequestHandler,
  ];
}

/**
 * Creates a middleware chain for authenticated routes with org ID requirement but no quota check.
 *
 * Applies middleware in order:
 * 1. requireAuth - Validates JWT and extracts user identity
 * 2. requireOrgId - Ensures request has x-org-id header
 * 3. withTenantContext - Opens the RLS tenant scope (orgId + isSuperAdmin) for the request
 *
 * Use this for read-only routes that don't consume quota.
 *
 * @returns Array of middleware handlers ready to spread into route definition
 *
 * @example
 * ```typescript
 * router.get('/',
 *   ...createAuthenticatedWithOrgRoute(),
 *   async (req, res) => {
 *     // Handler implementation
 *   }
 * );
 * ```
 */
export function createAuthenticatedWithOrgRoute(): RequestHandler[] {
  return [
    requireAuth as RequestHandler,
    requireOrgId() as RequestHandler,
    withTenantContext() as RequestHandler,
  ];
}
