import type { QuotaType, QuotaService } from '@mwashburn160/api-core';
import { RequestHandler } from 'express';
import { checkQuota } from './check-quota';
import { requireAuth } from './middleware';
import { requireOrgId } from './require-org-id';

/**
 * Creates a middleware chain for protected routes requiring authentication, org ID, and quota check.
 *
 * Applies middleware in order:
 * 1. requireAuth - Validates JWT and extracts user identity
 * 2. requireOrgId - Ensures request has x-org-id header
 * 3. checkQuota - Validates quota for the specified resource type
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
    checkQuota(quotaService, quotaType) as RequestHandler,
  ];
}

/**
 * Creates a middleware chain for authenticated routes with org ID requirement but no quota check.
 *
 * Applies middleware in order:
 * 1. requireAuth - Validates JWT and extracts user identity
 * 2. requireOrgId - Ensures request has x-org-id header
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
  ];
}
