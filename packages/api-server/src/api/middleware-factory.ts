/**
 * @module api/middleware-factory
 * @description Factory functions for composing common middleware chains.
 *
 * Reduces boilerplate by providing pre-configured middleware combinations
 * for common route patterns (public, authenticated, protected with quota).
 */

import type { QuotaType, QuotaService } from '@mwashburn160/api-core';
import { RequestHandler } from 'express';
import { checkQuota } from './check-quota';
import { authenticateToken } from './middleware';
import { requireOrgId } from './require-org-id';
import type { SSEManager } from '../http/sse-connection-manager';

/**
 * Creates a middleware chain for protected routes requiring authentication, org ID, and quota check.
 *
 * Applies middleware in order:
 * 1. authenticateToken - Validates JWT and extracts user identity
 * 2. requireOrgId - Ensures request has x-org-id header
 * 3. checkQuota - Validates quota for the specified resource type
 *
 * @param sseManager - SSE manager for request context logging
 * @param quotaService - Quota service client
 * @param quotaType - Which quota to check (e.g., 'apiCalls', 'pipelines', 'plugins')
 * @returns Array of middleware handlers ready to spread into route definition
 *
 * @example
 * ```typescript
 * router.post('/',
 *   ...createProtectedRoute(sseManager, quotaService, 'pipelines'),
 *   async (req, res) => {
 *     // Handler implementation
 *   }
 * );
 * ```
 */
export function createProtectedRoute(
  sseManager: SSEManager,
  quotaService: QuotaService,
  quotaType: QuotaType,
): RequestHandler[] {
  return [
    authenticateToken as RequestHandler,
    requireOrgId(sseManager) as RequestHandler,
    checkQuota(quotaService, sseManager, quotaType) as RequestHandler,
  ];
}

/**
 * Creates a middleware chain for authenticated routes requiring only JWT validation.
 *
 * Applies middleware in order:
 * 1. authenticateToken - Validates JWT and extracts user identity
 *
 * Use this for routes that don't require quota checks or org ID validation.
 *
 * @param sseManager - SSE manager for request context logging
 * @returns Array of middleware handlers ready to spread into route definition
 *
 * @example
 * ```typescript
 * router.get('/profile',
 *   ...createAuthenticatedRoute(sseManager),
 *   async (req, res) => {
 *     // Handler implementation
 *   }
 * );
 * ```
 */
export function createAuthenticatedRoute(sseManager: SSEManager): RequestHandler[] {
  // Note: sseManager is kept in signature for consistency, though not currently used
  // May be used for SSE-based logging in future
  void sseManager;
  return [
    authenticateToken as RequestHandler,
  ];
}

/**
 * Creates a middleware chain for authenticated routes with org ID requirement but no quota check.
 *
 * Applies middleware in order:
 * 1. authenticateToken - Validates JWT and extracts user identity
 * 2. requireOrgId - Ensures request has x-org-id header
 *
 * Use this for read-only routes that don't consume quota.
 *
 * @param sseManager - SSE manager for request context logging
 * @returns Array of middleware handlers ready to spread into route definition
 *
 * @example
 * ```typescript
 * router.get('/',
 *   ...createAuthenticatedWithOrgRoute(sseManager),
 *   async (req, res) => {
 *     // Handler implementation
 *   }
 * );
 * ```
 */
export function createAuthenticatedWithOrgRoute(sseManager: SSEManager): RequestHandler[] {
  return [
    authenticateToken as RequestHandler,
    requireOrgId(sseManager) as RequestHandler,
  ];
}

/**
 * Creates an empty middleware chain for public routes.
 *
 * Returns an empty array for consistency with other factory functions.
 * Use this for routes that don't require authentication.
 *
 * @returns Empty array of middleware handlers
 *
 * @example
 * ```typescript
 * router.get('/health',
 *   ...createPublicRoute(),
 *   async (req, res) => {
 *     res.json({ status: 'healthy' });
 *   }
 * );
 * ```
 */
export function createPublicRoute(): RequestHandler[] {
  return [];
}
