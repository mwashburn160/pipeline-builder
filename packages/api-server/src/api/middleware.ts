/**
 * @module api/middleware
 * @description Re-exports authentication middleware from api-core.
 *
 * This module provides convenient access to JWT authentication middleware
 * without needing to import directly from api-core.
 */

// Re-export all authentication middleware from api-core
export {
  requireAuth,
  optionalAuth,
  requireOrganization,
  requireAdmin,
  isSystemOrg,
  isSystemAdmin,
  type RequireAuthOptions,
} from '@mwashburn160/api-core';
