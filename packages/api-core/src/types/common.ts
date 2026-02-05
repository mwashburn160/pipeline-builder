/**
 * @module types/common
 * @description Common type definitions for API microservices.
 */

/**
 * Quota type identifiers.
 */
export type QuotaType = 'plugins' | 'pipelines' | 'apiCalls';

/**
 * Valid quota type values.
 */
export const VALID_QUOTA_TYPES: readonly QuotaType[] = ['plugins', 'pipelines', 'apiCalls'] as const;

/**
 * Type guard to check if a value is a valid QuotaType.
 *
 * @param value - Value to check
 * @returns True if value is a valid QuotaType
 *
 * @example
 * ```typescript
 * if (isValidQuotaType(req.body.quotaType)) {
 *   // quotaType is guaranteed to be QuotaType
 * }
 * ```
 */
export function isValidQuotaType(value: unknown): value is QuotaType {
  return typeof value === 'string' && VALID_QUOTA_TYPES.includes(value as QuotaType);
}

/**
 * Validate and assert that a value is a valid QuotaType.
 * Throws an error if validation fails.
 *
 * @param value - Value to validate
 * @param fieldName - Name of the field being validated (for error messages)
 * @returns The validated QuotaType
 * @throws Error if value is not a valid QuotaType
 *
 * @example
 * ```typescript
 * try {
 *   const quotaType = validateQuotaType(req.body.quotaType, 'quotaType');
 *   // Use quotaType safely
 * } catch (err) {
 *   return sendError(res, 400, err.message);
 * }
 * ```
 */
export function validateQuotaType(value: unknown, fieldName = 'quotaType'): QuotaType {
  if (!isValidQuotaType(value)) {
    throw new Error(
      `Invalid ${fieldName}: "${value}". Must be one of: ${VALID_QUOTA_TYPES.join(', ')}`,
    );
  }
  return value;
}

/**
 * Result from quota check operation.
 */
export interface QuotaCheckResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Maximum quota limit (-1 for unlimited) */
  limit: number;
  /** Current usage count */
  used: number;
  /** Remaining quota (-1 for unlimited) */
  remaining: number;
  /** ISO timestamp when quota resets */
  resetAt: string;
  /** Whether quota is unlimited */
  unlimited: boolean;
}

/**
 * Quota information for error responses.
 */
export interface QuotaInfo {
  type: QuotaType;
  limit: number;
  used: number;
  remaining: number;
}

/**
 * Standard API success response.
 */
export interface ApiSuccessResponse<T = unknown> {
  success: true;
  statusCode: number;
  data?: T;
  message?: string;
}

/**
 * Standard API error response.
 */
export interface ApiErrorResponse {
  success: false;
  statusCode: number;
  message: string;
  code?: string;
  details?: unknown;
  quota?: QuotaInfo;
}

/**
 * Combined API response type.
 */
export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * JWT payload from access tokens.
 */
export interface JwtPayload {
  /** User ID (subject) */
  sub: string;
  /** Username */
  username: string;
  /** User email */
  email: string;
  /** User role */
  role: 'user' | 'admin';
  /** Organization ID */
  organizationId?: string;
  /** Organization name */
  organizationName?: string;
  /** Token type */
  type: 'access' | 'refresh';
  /** Issued at timestamp */
  iat?: number;
  /** Expiration timestamp */
  exp?: number;
}

/**
 * Extended Express Request with user property.
 */
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * Service configuration for internal HTTP client.
 */
export interface ServiceConfig {
  /** Service hostname */
  host: string;
  /** Service port */
  port: number;
  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * Quota service configuration (single consolidated service).
 */
/**
 * Health check response.
 */
export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy';
  service: string;
  timestamp: string;
  uptime: number;
  version?: string;
  dependencies?: Record<string, 'connected' | 'disconnected' | 'unknown'>;
}
