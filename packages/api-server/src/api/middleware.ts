/**
 * @module api/middleware
 * @description Re-exports authentication middleware from api-core.
 *
 * This module provides convenient access to JWT authentication middleware
 * without needing to import directly from api-core.
 */

// Re-export all authentication middleware from api-core
export {
  authenticateToken,
  optionalAuth,
  requireOrganization,
  requireAdmin,
  isSystemOrg,
  isSystemAdmin,
  type AuthTokenOptions,
} from '@mwashburn160/api-core';
