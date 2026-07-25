// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { QuotaType, QuotaService } from '@pipeline-builder/api-core';
import type { RequestHandler } from 'express';
import { checkQuota } from './check-quota.js';
import { idempotencyMiddleware } from './idempotency-middleware.js';
import { requireAuth } from './middleware.js';
import { requireOrgId } from './require-org-id.js';
import { withTenantContext } from './tenant-context.js';

/**
 * Creates a middleware chain for protected routes requiring authentication, org ID, and quota check.
 *
 * Applies middleware in order:
 * 1. requireAuth - Validates JWT and extracts user identity
 * 2. requireOrgId - Ensures request has x-org-id header
 * 3. idempotencyMiddleware - Dedupes keyed mutation retries (no-op without an
 *    Idempotency-Key header or on non-mutation methods)
 * 4. withTenantContext - Opens the RLS tenant scope (orgId + isSuperAdmin) for the request
 * 5. checkQuota - Validates quota for the specified resource type
 *
 * Idempotency sits AFTER auth+orgId (so it can namespace the replay cache on the
 * VERIFIED org — a pre-auth global mount saw no identity and was a permanent
 * no-op) and BEFORE withTenantContext/checkQuota (so a replayed request short-
 * circuits without opening an RLS scope or spending a quota check).
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
    idempotencyMiddleware() as RequestHandler,
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
    // Mounted post-orgId (identity populated) so keyed mutation retries on the
    // non-quota routes — notably the create paths, which use this factory to
    // avoid the checkQuota pre-flight racing their reserve — are deduplicated.
    idempotencyMiddleware() as RequestHandler,
    withTenantContext() as RequestHandler,
  ];
}
